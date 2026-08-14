import { createRequire } from "node:module";

import {
  ListColumnsRequest,
  ListLineagesRequest,
  type Column,
  type LineageEntity,
  type ListLineagesResponseBodyPagingInfoLineages,
} from "@alicloud/dataworks-public20240518";

import type { MaxComputeConfig } from "../domain/index.js";
import type { MaxComputeCredentials } from "./maxcompute-client.js";

export interface DataWorksColumnRelation {
  sourceTable: string;
  sourceColumn: string;
  targetTable: string;
  targetColumn: string;
  taskId: string | null;
  taskType: string | null;
  createTime: number | null;
}

interface DataWorksSdk {
  listColumns(request: ListColumnsRequest): Promise<{ body?: { pagingInfo?: { columns?: Column[] } } }>;
  listLineages(request: ListLineagesRequest): Promise<{ body?: { pagingInfo?: { lineages?: ListLineagesResponseBodyPagingInfoLineages[]; totalCount?: number } } }>;
}

interface DataWorksClientConfig {
  accessKeyId: string;
  accessKeySecret: string;
  regionId: string;
  endpoint: string;
  protocol: string;
  connectTimeout: number;
  readTimeout: number;
  type?: string;
}
interface DataWorksClientConstructor { new(config: DataWorksClientConfig): DataWorksSdk }
const require = createRequire(import.meta.url);
const DataWorksClient = (require("@alicloud/dataworks-public20240518") as { default: DataWorksClientConstructor }).default;

export interface DataWorksColumnLineageClientOptions {
  credentials: MaxComputeCredentials;
  region: string;
  client?: DataWorksSdk;
  maximumPages?: number;
}

export class DataWorksColumnLineageClient {
  private readonly client: DataWorksSdk;
  private readonly maximumPages: number;

  constructor(options: DataWorksColumnLineageClientOptions) {
    this.maximumPages = options.maximumPages ?? 3;
    this.client = options.client ?? new DataWorksClient({
      accessKeyId: options.credentials.accessKeyId,
      accessKeySecret: options.credentials.accessKeySecret,
      regionId: options.region,
      endpoint: `dataworks.${options.region}.aliyuncs.com`,
      protocol: "https",
      connectTimeout: 5_000,
      readTimeout: 10_000,
    });
  }

  async queryColumn(input: { project: string; table: string; column: string }): Promise<DataWorksColumnRelation[]> {
    const tableId = `maxcompute-table:::${input.project}::${input.table}`;
    const columns = (await this.client.listColumns(new ListColumnsRequest({
      tableId,
      name: input.column,
      pageNumber: 1,
      pageSize: 100,
      sortBy: "Name",
      order: "Asc",
    }))).body?.pagingInfo?.columns ?? [];
    const selected = columns.find((item) => item.name?.toLocaleLowerCase() === input.column.toLocaleLowerCase());
    if (!selected?.id || !selected.name) return [];

    const lineages = [
      ...await this.listDirection({ dstEntityId: selected.id }),
      ...await this.listDirection({ srcEntityId: selected.id }),
    ];
    const relations = new Map<string, DataWorksColumnRelation>();
    for (const lineage of lineages) {
      const outerSource = parseMaxComputeColumn(lineage.srcEntity);
      const outerTarget = parseMaxComputeColumn(lineage.dstEntity);
      for (const relationship of lineage.relationships?.length ? lineage.relationships : [undefined]) {
        const source = parseMaxComputeColumn(relationship?.srcEntity) ?? outerSource;
        const target = parseMaxComputeColumn(relationship?.dstEntity) ?? outerTarget;
        if (!source || !target) continue;
        const relation: DataWorksColumnRelation = {
          sourceTable: `${source.project}.${source.table}`,
          sourceColumn: source.column,
          targetTable: `${target.project}.${target.table}`,
          targetColumn: target.column,
          taskId: relationship?.task?.id ?? null,
          taskType: relationship?.task?.type ?? null,
          createTime: relationship?.createTime ?? null,
        };
        relations.set(relationKey(relation), relation);
      }
    }
    return [...relations.values()];
  }

  private async listDirection(filter: { srcEntityId?: string; dstEntityId?: string }): Promise<ListLineagesResponseBodyPagingInfoLineages[]> {
    const output: ListLineagesResponseBodyPagingInfoLineages[] = [];
    for (let pageNumber = 1; pageNumber <= this.maximumPages; pageNumber += 1) {
      const response = await this.client.listLineages(new ListLineagesRequest({
        ...filter,
        needAttachRelationship: true,
        pageNumber,
        pageSize: 100,
        sortBy: "Name",
        order: "Asc",
      }));
      const paging = response.body?.pagingInfo;
      const rows = paging?.lineages ?? [];
      output.push(...rows);
      if (!rows.length || output.length >= (paging?.totalCount ?? 0)) break;
    }
    return output;
  }
}

export function inferDataWorksRegion(config: MaxComputeConfig, project: string): string | null {
  const discovered = config.discoveredProjects.find((item) => item.name.toLocaleLowerCase() === project.toLocaleLowerCase())?.region;
  if (discovered && /^[a-z]{2}-[a-z0-9-]+$/i.test(discovered)) return discovered.toLocaleLowerCase();
  const match = config.endpoint.match(/(?:^|\.)([a-z]{2}-[a-z0-9-]+)\.maxcompute\./i);
  return match?.[1]?.toLocaleLowerCase() ?? null;
}

export function splitMaxComputeTable(value: string, defaultProject: string): { project: string; table: string } | null {
  const parts = value.split(".").filter(Boolean);
  if (parts.length === 1 && defaultProject) return { project: defaultProject, table: parts[0]! };
  if (parts.length === 2) return { project: parts[0]!, table: parts[1]! };
  return null;
}

function parseMaxComputeColumn(entity: LineageEntity | undefined): { project: string; table: string; column: string } | null {
  if (!entity?.id) return null;
  const parts = entity.id.split(":");
  if (parts[0] !== "maxcompute-column" || parts.length < 7) return null;
  const project = parts[3] ?? "";
  const table = parts.at(-2) ?? "";
  const column = parts.at(-1) ?? "";
  return project && table && column ? { project, table, column } : null;
}

function relationKey(value: Pick<DataWorksColumnRelation, "sourceTable" | "sourceColumn" | "targetTable" | "targetColumn">): string {
  return [value.sourceTable, value.sourceColumn, value.targetTable, value.targetColumn].map((item) => item.toLocaleLowerCase()).join("\u0000");
}
