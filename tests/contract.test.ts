import { describe, it, expect } from 'vitest';
import { taskIdentifier, checkContractBatch } from '../src/contract.js';
import type { TaskProperties } from '../src/types.js';

function makeTask(overrides: Partial<TaskProperties> = {}): TaskProperties {
  return {
    id: 'page-id-1',
    url: 'https://notion.so/page-id-1',
    '任务名称': '测试任务',
    'Task ID': 'TASK-001',
    'Gate序号': 1,
    '优先级': 'P2 中',
    '状态': 'DRAFT',
    '执行方': 'Worker A',
    '执行模式': '',
    '任务时长': '',
    '任务类型': '',
    '任务域': '',
    '任务子域': '',
    '数据等级': '',
    '前置任务': '',
    '人工判断点': '',
    '允许自动关闭': '',
    '允许调用外部编码代理': '',
    '自动派活': '',
    '计划时间': '',
    '开始时间': '',
    'Run ID': '',
    '执行会话': '',
    '领取前预检': '',
    '执行可观测Gate': '',
    '提交前Gate': '',
    '提交前Gate报告': '',
    '当前里程碑': '',
    '所属项目': [],
    '版本号': 1,
    '需求版本': 1,
    '需求Hash': '',
    '证据包Hash': '',
    '结果': '',
    '结果摘要': '',
    '结果证据': '',
    '进度': 0,
    '等待原因': '',
    '释放条件': '',
    '变更摘要': '',
    '变更路径': '',
    '修正策略': '',
    '返工根因': '',
    '最后错误': '',
    '最大自动重试': 2,
    '重试次数': 0,
    '契约完整性': '',
    '执行评价': '',
    '执行通道': '',
    '并行组': '',
    '更新时间': '',
    '上次心跳': '',
    '反馈时间': '',
    '下次反馈': '',
    '租约到期': '',
    '领取批次': '',
    'Obsidian路径': '',
    'RE复核意见': '',
    '需求变更处置': '',
    '页面ID': '',
    'Automation Run ID': '',
    'Update Source': '',
    'Pre-Hash': '',
    'Post-Hash': '',
    ...overrides,
  };
}

describe('taskIdentifier', () => {
  it('prefers Task ID when present', () => {
    const task = makeTask({ 'Task ID': 'TASK-ABC', id: 'page-id', '任务名称': '名称' });
    expect(taskIdentifier(task)).toBe('TASK-ABC');
  });

  it('falls back to Notion page id when Task ID is empty', () => {
    const task = makeTask({ 'Task ID': '', id: 'page-id-xyz', '任务名称': '名称' });
    expect(taskIdentifier(task)).toBe('page-id-xyz');
  });

  it('falls back to trimmed 任务名称 when Task ID and id are empty', () => {
    const task = makeTask({ 'Task ID': '', id: '', '任务名称': '  无名任务  ' });
    expect(taskIdentifier(task)).toBe('无名任务');
  });

  it('returns unnamed when nothing is available', () => {
    const task = makeTask({ 'Task ID': '', id: '', '任务名称': '' });
    expect(taskIdentifier(task)).toBe('unnamed');
  });
});

describe('checkContractBatch identifier reporting', () => {
  it('reports a non-empty identifier for a task with empty Task ID', () => {
    const task = makeTask({ 'Task ID': '', id: 'page-empty-task', '任务名称': 'Empty ID Task' });
    const results = checkContractBatch([task], [task]);
    const keys = Array.from(results.keys());
    expect(keys.length).toBe(1);
    expect(keys[0]).not.toBe('');
    expect(keys[0]).toBe('page-empty-task');
    expect(results.get(keys[0])!.ok).toBe(false);
  });

  it('includes both tasks when two tasks are missing Task ID', () => {
    const taskA = makeTask({
      id: 'page-a',
      'Task ID': '',
      '任务名称': 'Missing A',
    });
    const taskB = makeTask({
      id: 'page-b',
      'Task ID': '',
      '任务名称': 'Missing B',
    });
    const results = checkContractBatch([taskA, taskB], [taskA, taskB]);
    const keys = Array.from(results.keys());
    expect(keys).toContain('page-a');
    expect(keys).toContain('page-b');
    expect(keys.length).toBe(2);
  });

  it('keeps Task ID as the key for a normal task', () => {
    const task = makeTask({ 'Task ID': 'TASK-NORMAL', '任务名称': 'Normal' });
    const results = checkContractBatch([task], [task]);
    expect(Array.from(results.keys())).toEqual(['TASK-NORMAL']);
    expect(results.get('TASK-NORMAL')!.ok).toBe(true);
  });
});
