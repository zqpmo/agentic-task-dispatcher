import { Client, APIResponseError } from '@notionhq/client';
import { AppConfig, TaskProperties, ProjectProperties, RecordProperties, RunContext } from './types.js';

let _client: Client | null = null;

export function getNotionClient(config: AppConfig): Client {
  if (!_client) {
    const apiKey = process.env.NOTION_API_KEY;
    if (!apiKey) {
      throw new Error('[NOTION] NOTION_API_KEY env var not set');
    }
    _client = new Client({ auth: apiKey });
  }
  return _client;
}

// --- Query helpers ---

export async function queryTasks(
  client: Client,
  filter: string = 'DRAFT',
  limit: number = 10
): Promise<TaskProperties[]> {
  const dbId = config.notion.data_sources.tasks.replace('collection://', '');
  const response = await client.databases.query({
    database_id: dbId,
    filter: buildStatusFilter(filter),
    sorts: [{ property: '更新时间', direction: 'ascending' }],
    page_size: limit,
  });
  return response.results.map(r => parseTaskProperties(r));
}

export async function queryAllTasks(client: Client): Promise<TaskProperties[]> {
  const dbId = config.notion.data_sources.tasks.replace('collection://', '');
  const all: TaskProperties[] = [];
  let cursor: string | undefined;
  do {
    const resp = await client.databases.query({
      database_id: dbId,
      page_size: 100,
      start_cursor: cursor,
    });
    all.push(...resp.results.map(r => parseTaskProperties(r)));
    cursor = resp.has_more ? (resp.next_cursor || undefined) : undefined;
  } while (cursor);
  return all;
}

export async function queryProjects(client: Client): Promise<ProjectProperties[]> {
  const dbId = config.notion.data_sources.projects.replace('collection://', '');
  const resp = await client.databases.query({
    database_id: dbId,
    page_size: 100,
  });
  return resp.results.map(r => parseProjectProperties(r));
}

export async function queryRecords(
  client: Client,
  recordType: string = ''
): Promise<RecordProperties[]> {
  const dbId = config.notion.data_sources.records.replace('collection://', '');
  const filter: any = {};
  if (recordType) {
    filter.property = '记录类型';
    filter.select = { equals: recordType };
  }
  const resp = await client.databases.query({
    database_id: dbId,
    filter: Object.keys(filter).length > 0 ? filter : undefined,
    page_size: 100,
  });
  return resp.results.map(r => parseRecordProperties(r));
}

// --- Write helpers (idempotent) ---

export async function updateTask(
  client: Client,
  pageId: string,
  properties: Partial<TaskProperties>,
  ctx: RunContext
): Promise<boolean> {
  const notionProps: any = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined || value === null) continue;
    const built = buildPropertyValue(key, value);
    // 库中不存在的属性返回 undefined，必须跳过而非写入
    if (built === undefined) continue;
    notionProps[key] = built;
  }
  // 不再无条件覆盖 Run ID（旧行为污染任务 Run ID / 造成第二 Run）

  try {
    await client.pages.update({ page_id: pageId, properties: notionProps });
    return true;
  } catch (e: any) {
    if (e instanceof APIResponseError && e.status === 409) {
      console.warn(`[NOTION] Conflict updating ${pageId}: ${e.message}`);
      return false;
    }
    throw e;
  }
}

export async function updateProject(
  client: Client,
  pageId: string,
  properties: Partial<ProjectProperties>,
  ctx: RunContext
): Promise<boolean> {
  // Map internal field names to actual Notion property names
  const notionProps: any = {};
  if (properties['进度'] !== undefined) notionProps['项目进度'] = { number: properties['进度'] };
  if (properties['阶段'] !== undefined) notionProps['当前阶段'] = { select: { name: properties['阶段'] } };
  if (properties['健康度'] !== undefined) notionProps['健康度'] = { select: { name: properties['健康度'] } };
  if (properties['版本号'] !== undefined) notionProps['基线版本'] = { number: properties['版本号'] };

  try {
    await client.pages.update({ page_id: pageId, properties: notionProps });
    return true;
  } catch (e: any) {
    if (e instanceof APIResponseError && e.status === 409) {
      console.warn(`[NOTION] Conflict updating project ${pageId}: ${e.message}`);
      return false;
    }
    throw e;
  }
}

// --- v5: Update Record Gate Title ---
// 只在 Gate 编号、总数或基线变化时更新标题前缀
// 状态变化不改标题；输入缺失只报错不写入

export async function updateRecordTitle(
  client: Client,
  pageId: string,
  newTitle: string,
  ctx: RunContext
): Promise<boolean> {
  try {
    await client.pages.update({
      page_id: pageId,
      properties: {
        '记录名称': { title: [{ text: { content: newTitle } }] },
      },
    });
    return true;
  } catch (e: any) {
    if (e instanceof APIResponseError && e.status === 409) {
      console.warn(`[NOTION] Conflict updating record title ${pageId}: ${e.message}`);
      return false;
    }
    throw e;
  }
}

export async function createRecord(
  client: Client,
  properties: Partial<RecordProperties>
): Promise<string> {
  const dbId = config.notion.data_sources.records.replace('collection://', '');
  const notionProps: any = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined || value === null) continue;
    notionProps[key] = buildPropertyValue(key, value);
  }

  const resp = await client.pages.create({
    parent: { database_id: dbId },
    properties: notionProps,
  });
  return resp.id;
}

// --- Filter builders ---

function buildStatusFilter(status: string): any {
  // 状态 在库中为 status 类型，过滤器必须使用 status
  return {
    property: '状态',
    status: { equals: status },
  };
}

// --- Property value builders ---

function buildPropertyValue(key: string, value: any): any {
  // 库中不存在的属性禁止写入（旧版写 Pre-Hash 使整轮 API 报错）
  if (key === 'Pre-Hash' || key === 'Post-Hash') return undefined;
  // 状态 属性为 status 类型，必须使用 status 序列化
  if (key === '状态') return { status: { name: String(value) } };
  // url 属性必须按 url 序列化（执行会话）
  if (key === '执行会话') return { url: value ? String(value) : null };
  // date 属性必须按 date 序列化（Run 四要素中的开始时间/心跳/租约）
  if (['计划时间', '开始时间', '上次心跳', '反馈时间', '下次反馈', '租约到期'].includes(key)) {
    return value ? { date: { start: String(value) } } : { date: null };
  }
  if (typeof value === 'string') {
    if (['执行方', '执行模式', '任务时长', '任务类型', '数据等级', '领取前预检', '执行可观测Gate', '提交前Gate', '契约完整性', '结果', '记录类型', 'Gate状态', '模型', 'Provider', '原因', '影响'].includes(key)) {
      return { select: { name: value } };
    }
    if (['Run ID', '执行会话', 'Task ID', 'Project ID', 'Automation Run ID', 'Update Source', '证据包Hash', '需求Hash', '基线Hash', '基线版本', '阶段', '健康度', 'Obsidian路径', 'RE复核意见', '需求变更处置', '页面ID', '领取批次', '变更摘要', '变更路径', '修正策略', '返工根因', '最后错误', '等待原因', '释放条件', '当前里程碑', '结果摘要', '结果证据', '证据摘要', '步骤', '时间', '项目名称', '任务名称'].includes(key)) {
      return { rich_text: [{ text: { content: value } }] };
    }
    if (['任务域', '任务子域', '任务名称', '项目名称'].includes(key)) {
      return { title: [{ text: { content: value } }] };
    }
    return { rich_text: [{ text: { content: String(value) } }] };
  }
  if (typeof value === 'number') {
    return { number: value };
  }
  if (typeof value === 'boolean') {
    return { checkbox: value };
  }
  if (Array.isArray(value)) {
    return { relation: value.map(id => ({ id })) };
  }
  return { rich_text: [{ text: { content: String(value) } }] };
}

// --- Property parsers ---

function parseTaskProperties(result: any): TaskProperties {
  const p = result.properties || {};
  return {
    id: result.id,
    url: result.url || '',
    "任务名称": getTitle(p, '任务名称'),
    "Task ID": getRichText(p, 'Task ID'),
    "Gate序号": getNumber(p, 'Gate序号') ?? '',
    "优先级": getSelect(p, '优先级'),
    "状态": getStatus(p, '状态'),
    "执行方": getSelect(p, '执行方'),
    "执行模式": getSelect(p, '执行模式'),
    "任务时长": getSelect(p, '任务时长'),
    "任务类型": getSelect(p, '任务类型'),
    "任务域": getRichText(p, '任务域'),
    "任务子域": getRichText(p, '任务子域'),
    "数据等级": getSelect(p, '数据等级'),
    "前置任务": getRichText(p, '前置任务'),
    // 四个属性在库中为 checkbox，必须按 checkbox 读取
    "人工判断点": getCheckbox(p, '人工判断点'),
    "允许自动关闭": getCheckbox(p, '允许自动关闭'),
    "允许调用外部编码代理": getCheckbox(p, '允许调用外部编码代理'),
    "自动派活": getCheckbox(p, '自动派活'),
    "计划时间": getDate(p, '计划时间'),
    "开始时间": getDate(p, '开始时间'),
    "Run ID": getRichText(p, 'Run ID'),
    // 执行会话 为 url 类型属性，必须按 url 读取（Run 四要素之一）
    "执行会话": getUrl(p, '执行会话'),
    "领取前预检": getSelect(p, '领取前预检'),
    "执行可观测Gate": getSelect(p, '执行可观测Gate'),
    "提交前Gate": getSelect(p, '提交前Gate'),
    "提交前Gate报告": getRichText(p, '提交前Gate报告'),
    "当前里程碑": getRichText(p, '当前里程碑'),
    "所属项目": getRelation(p, '所属项目'),
    "版本号": getNumber(p, '版本号') || 1,
    "需求版本": getNumber(p, '需求版本') || 1,
    "需求Hash": getRichText(p, '需求Hash'),
    "证据包Hash": getRichText(p, '证据包Hash'),
    "结果": getSelect(p, '结果'),
    "结果摘要": getRichText(p, '结果摘要'),
    "结果证据": getRichText(p, '结果证据'),
    "进度": getNumber(p, '进度') || 0,
    "等待原因": getRichText(p, '等待原因'),
    "释放条件": getRichText(p, '释放条件'),
    "变更摘要": getRichText(p, '变更摘要'),
    "变更路径": getRichText(p, '变更路径'),
    "修正策略": getRichText(p, '修正策略'),
    "返工根因": getRichText(p, '返工根因'),
    "最后错误": getRichText(p, '最后错误'),
    "最大自动重试": getNumber(p, '最大自动重试') || 2,
    "重试次数": getNumber(p, '重试次数') || 0,
    "契约完整性": getSelect(p, '契约完整性'),
    "执行评价": getRichText(p, '执行评价'),
    "执行通道": getRichText(p, '执行通道'),
    "并行组": getRichText(p, '并行组'),
    "更新时间": getCreatedTime(p),
    "上次心跳": getDate(p, '上次心跳'),
    "反馈时间": getDate(p, '反馈时间'),
    "下次反馈": getDate(p, '下次反馈'),
    "租约到期": getDate(p, '租约到期'),
    "领取批次": getRichText(p, '领取批次'),
    "Obsidian路径": getRichText(p, 'Obsidian路径'),
    "RE复核意见": getRichText(p, 'RE复核意见'),
    "需求变更处置": getRichText(p, '需求变更处置'),
    "页面ID": getRichText(p, '页面ID'),
    "Automation Run ID": getRichText(p, 'Run ID'),
    "Update Source": '',
  };
}

function parseProjectProperties(result: any): ProjectProperties {
  const p = result.properties || {};
  return {
    id: result.id,
    url: result.url || '',
    "项目名称": getTitle(p, '项目名称'),
    "Project ID": getRichText(p, 'Project ID'),
    "状态": getStatus(p, '状态'),
    "阶段": getSelect(p, '当前阶段'),
    "进度": getNumber(p, '项目进度') ?? 0,
    "基线版本": getRichText(p, '基线版本'),
    "基线Hash": getRichText(p, '基线Hash'),
    "健康度": getSelect(p, '健康度'),
    "版本号": getNumber(p, '基线版本') ?? 1,
    "计划步骤总数": getNumber(p, '计划步骤总数') ?? 0,
    "Automation Run ID": '',
    "Update Source": '',
  };
}

function parseRecordProperties(result: any): RecordProperties {
  const p = result.properties || {};
  return {
    id: result.id,
    url: result.url || '',
    "记录类型": getSelect(p, '记录类型'),
    "Task ID": getRichText(p, 'Task ID'),
    "Run ID": getRichText(p, 'Run ID'),
    "Gate序号": getRichText(p, 'Gate序号'),
    "Gate状态": getSelect(p, 'Gate状态'),
    "模型": getRichText(p, '模型'),
    "Provider": getRichText(p, 'Provider'),
    "步骤": getRichText(p, '步骤'),
    "原因": getRichText(p, '原因'),
    "时间": getDate(p, '时间'),
    "Token": getNumber(p, 'Token') || 0,
    "成本": getNumber(p, '成本') || 0,
    "影响": getRichText(p, '影响'),
    "证据摘要": getRichText(p, '证据摘要'),
    "版本号": getNumber(p, '版本号') || 1,
    // v4: 可视化编号体系
    "序号": getNumber(p, '序号') ?? '',
    "纳入流程": (p['纳入流程']?.checkbox ?? false),
    "总步骤数": getNumber(p, '总步骤数') ?? 0,
    "流程标识": getRichText(p, '流程标识'),
    "记录显示名": getRichText(p, '记录显示名'),
    "记录名称": getTitle(p, '记录名称'),
    "所属项目": getRelation(p, '所属项目'),
    "Automation Run ID": getRichText(p, 'Automation Run ID'),
    "Update Source": getSelect(p, '更新来源'),
  };
}

// --- Property getters ---

function getTitle(p: any, key: string): string {
  const prop = p[key];
  if (!prop || !prop.title) return '';
  return prop.title.map((t: any) => t.plain_text || t.content || '').join('');
}

function getRichText(p: any, key: string): string {
  const prop = p[key];
  if (!prop) return '';
  if (prop.rich_text) {
    return prop.rich_text.map((t: any) => t.plain_text || t.content || '').join('');
  }
  if (prop.title) {
    return prop.title.map((t: any) => t.plain_text || t.content || '').join('');
  }
  if (typeof prop === 'string') return prop;
  return '';
}

function getSelect(p: any, key: string): string {
  const prop = p[key];
  if (!prop || !prop.select) return '';
  return prop.select.name || '';
}

// checkbox getter（人工判断点/允许自动关闭/允许调用外部编码代理/自动派活）
function getCheckbox(p: any, key: string): boolean {
  const prop = p[key];
  if (!prop) return false;
  if (typeof prop.checkbox === 'boolean') return prop.checkbox;
  if (prop.select && (prop.select.name === '__YES__' || prop.select.name === 'true')) return true;
  return false;
}

// url getter（执行会话）
function getUrl(p: any, key: string): string {
  const prop = p[key];
  if (!prop) return '';
  if (typeof prop.url === 'string') return prop.url;
  if (prop.rich_text) return prop.rich_text.map((t: any) => t.plain_text || t.content || '').join('');
  return '';
}

function getStatus(p: any, key: string): string {
  const prop = p[key];
  if (!prop || !prop.status) return '';
  return prop.status.name || '';
}

function getNumber(p: any, key: string): number | null {
  const prop = p[key];
  if (!prop || !prop.number) return null;
  return prop.number;
}

function getDate(p: any, key: string): string {
  const prop = p[key];
  if (!prop || !prop.date || !prop.date.start) return '';
  return prop.date.start;
}

function getRelation(p: any, key: string): string[] {
  const prop = p[key];
  if (!prop || !prop.relation) return [];
  return prop.relation.map((r: any) => r.id);
}

function getCreatedTime(p: any): string {
  return p['更新时间']?.date?.start || '';
}

// Module-level config injected by initNotionConfig before any query helpers run.
let config: AppConfig;
export function initNotionConfig(cfg: AppConfig) {
  config = cfg;
}
