import {Injectable, Injector} from '@angular/core';
import {FetchClient} from '@c8y/ngx-components/api';
import {IFetchOptions} from '@c8y/client';
import {IFetchResponse} from "@c8y/client/lib/src/core/IFetchResponse";
import {defer, Observable} from "rxjs";
import {filter, first} from "rxjs/operators";
import {repeatBackoff} from "./repeatBackoff";

export interface QueryConfig {
  timeout: number,
  offset: number,
  limit: number
}

export type DatasetFieldType = "STRUCT" | "LIST" | "UNION" | "INTEGER" | "BIGINT" | "FLOAT" | "DOUBLE" | "VARCHAR" | "VARBINARY" | "BOOLEAN" | "DECIMAL" | "TIME" | "DATE" | "TIMESTAMP" | "INTERVAL DAY TO SECOND" | "INTERVAL YEAR TO MONTH";

export interface DatasetField {
  name: string,
  type: {
      name: DatasetFieldType,
      subSchema?: DatasetField,
      precision?: number,
      scale?: number
  }
}

export interface Job {
  id: string
}

export interface JobResult<T> {
  rowCount: Number,
  schema: DatasetField[],
  rows: T[]
}

export interface JobStatus {
  jobState: "PENDING" | "METADATA_RETRIEVAL" | "PLANNING" | "QUEUED" | "ENGINE_START" | "EXECUTION_PLANNING" | "STARTING" | "RUNNING" | "COMPLETED" | "CANCELLED" | "FAILED",
  queryType: "UI_RUN" | "UI_PREVIEW" | "UI_INTERNAL_PREVIEW" | "UI_INTERNAL_RUN" | "UI_EXPORT" | "ODBC" | "JDBC" | "REST" | "ACCELERATOR_CREATE" | "ACCELERATOR_DROP" | "UNKNOWN" | "PREPARE_INTERNAL" | "ACCELERATOR_EXPLAIN" | "UI_INITIAL_PREVIEW",
  startedAt: string,
  endedAt: string,
  rowCount?: number,
  acceleration?: any,
  errorMessage?: string
}

@Injectable({ providedIn: 'root' })
export class QueryService {
  private readonly dataHubDremioApi = '/service/datahub/dremio/api/v3';
  private readonly fetchClient: FetchClient;

  private fetchOptions: IFetchOptions = {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' }
  };

  constructor(injector: Injector) {
    // Cumulocity won't let you inject this if your @Injectable is provided in root... so this is a workaround..
    this.fetchClient = injector.get(FetchClient);
  }

  async queryForResults<T = any>(queryString: string, config: Partial<QueryConfig> = {}): Promise<JobResult<T>> {
    const fullConfig: QueryConfig = { timeout: Number.POSITIVE_INFINITY, offset: 0, limit: 100, ...config };

    //post job to api
    const job = await this.postQuery(queryString);
    const jobId = job.id.toString();

    const jobStatusOrTimeout = await Promise.race([this.waitForJobToComplete(jobId), this.sleep(config.timeout)]);

    if (jobStatusOrTimeout === undefined) {
      try {
        await this.cancelJob(jobId);
      } catch(e) {
        throw new Error("Query timed out but was unable to cancel");
      }
      throw new Error("Query timed out");
    }

    const jobStatus = jobStatusOrTimeout as JobStatus

    if (jobStatus.jobState === "COMPLETED") {
      return await this.getJobResults<T>(jobId, fullConfig.offset, fullConfig.limit);
    } else if (jobStatus.jobState === "CANCELLED") {
      throw new Error(`DataHub Query Job Cancelled`);
    } else if (jobStatus.errorMessage) {
      throw new Error(jobStatus.errorMessage);
    } else {
      throw new Error(`DataHub Query Job Failed, status: ${jobStatus.jobState}`);
    }
  }

  async waitForJobToComplete(jobId: string): Promise<JobStatus> {
    return this.waitForJobToComplete$(jobId).toPromise();
  }

  waitForJobToComplete$(jobId: string): Observable<JobStatus> {
    return defer(() => this.getJobStatus(jobId))
      .pipe(
        repeatBackoff({initialDelay: 300, maxDelay: 30000}),
        filter(jobStatus => ["COMPLETED", "CANCELLED", "FAILED"].includes(jobStatus.jobState)),
        first()
      )
  }

  async getJobStatus(jobId: string): Promise<JobStatus> {
    const response = await this.fetchClient.fetch(`${this.dataHubDremioApi}/job/${jobId}`, this.fetchOptions);
    if (response.status >= 200 && response.status < 300) {
      return response.json();
    } else {
      await this.throwErrorResponse(response);
    }
  }

  async getJobResults<T = any>(jobId: string, offset: number = 0, limit: number = 100): Promise<JobResult<T>> {
    const response = await this.fetchClient.fetch(`${this.dataHubDremioApi}/job/${jobId}/results?offset=${offset}&limit=${limit}`, this.fetchOptions)
    if (response.status >= 200 && response.status < 300) {
      return response.json();
    } else {
      await this.throwErrorResponse(response);
    }
  }

  async postQuery(query: String): Promise<Job> {
    const response = await this.fetchClient.fetch(this.dataHubDremioApi + '/sql', { ...this.fetchOptions, method: 'POST', body: JSON.stringify({ sql: query }) })
    if (response.status >= 200 && response.status < 300) {
      return response.json();
    } else {
      await this.throwErrorResponse(response);
    }
  }

  async cancelJob(jobId: string): Promise<any> {
    const response = await this.fetchClient.fetch(`${this.dataHubDremioApi}/job/${jobId}/cancel`, {...this.fetchOptions, method: 'POST'});
    if (response.status >= 200 && response.status < 300) {
      return response.json();
    } else {
      await this.throwErrorResponse(response);
    }
  }

  sleep(milliseconds: number): Promise<void> {
    if (milliseconds === Number.POSITIVE_INFINITY || milliseconds < 0) {
      return new Promise(() => {});
    } else {
      return new Promise(resolve => setTimeout(() => resolve(), milliseconds));
    }
  }

  // noinspection JSMethodCanBeStatic
  private async throwErrorResponse(response: IFetchResponse) {
    // Can only access response body once so we get it as text and then manually json-ify it
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {}
    if (json && json.errorMessage) {
      throw new Error(json.errorMessage);
    } else {
      throw new Error(text);
    }
  }
}
