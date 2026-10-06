import type { AudioAsset, AudioClip, AudioProject, AudioTrack } from '../types/audio';
import { backfillBase, mergeProjects, resolveBase } from './projectMerge';

let failures = 0;
function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    console.error(`  ✗ ${message}`);
    failures += 1;
  }
}

function makeClip(id: string, assetId: string, overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    id,
    assetId,
    name: `clip-${id}`,
    start: 0,
    duration: 4,
    offset: 0,
    fadeIn: 0,
    fadeOut: 0,
    effect: 'none',
    effectAmount: 0,
    ...overrides,
  };
}

function makeTrack(id: string, clips: AudioClip[], overrides: Partial<AudioTrack> = {}): AudioTrack {
  return {
    id,
    name: `track-${id}`,
    color: '#2563eb',
    volume: 0.8,
    pan: 0,
    muted: false,
    solo: false,
    height: 112,
    clips,
    ...overrides,
  };
}

function makeAsset(id: string, overrides: Partial<AudioAsset> = {}): AudioAsset {
  return {
    id,
    name: `asset-${id}`,
    source: 'imported',
    duration: 4,
    mimeType: 'audio/mpeg',
    dataUrl: 'data:audio/mpeg;base64,xxx',
    ...overrides,
  };
}

function makeProject(tracks: AudioTrack[], assets: AudioAsset[], base?: AudioProject): AudioProject {
  return {
    version: 1,
    name: 'test',
    bpm: 120,
    snap: 0.25,
    loopEnabled: false,
    loopStart: 0,
    loopEnd: 8,
    pixelsPerSecond: 92,
    tracks,
    assets,
    updatedAt: 0,
    base,
  };
}

function clipIds(track: AudioTrack): string[] {
  return track.clips.map((c) => c.id);
}

console.log('场景1：只有本机改了片段，采用本机版本');
{
  const base = makeProject(
    [makeTrack('t1', [makeClip('c1', 'a1', { start: 0 })])],
    [makeAsset('a1')],
  );
  const ours = makeProject(
    [makeTrack('t1', [makeClip('c1', 'a1', { start: 2 })])],
    [makeAsset('a1')],
  );
  const theirs = makeProject(
    [makeTrack('t1', [makeClip('c1', 'a1', { start: 0 })])],
    [makeAsset('a1')],
  );
  const { project, stats } = mergeProjects(base, ours, theirs);
  assert(project.tracks[0].clips[0].start === 2, '采用本机改动后的 start=2');
  assert(stats.clipConflicts === 0, '无冲突');
}

console.log('场景2：只有对方改了片段，采用对方版本');
{
  const base = makeProject(
    [makeTrack('t1', [makeClip('c1', 'a1', { start: 0 })])],
    [makeAsset('a1')],
  );
  const ours = makeProject(
    [makeTrack('t1', [makeClip('c1', 'a1', { start: 0 })])],
    [makeAsset('a1')],
  );
  const theirs = makeProject(
    [makeTrack('t1', [makeClip('c1', 'a1', { start: 3 })])],
    [makeAsset('a1')],
  );
  const { project } = mergeProjects(base, ours, theirs);
  assert(project.tracks[0].clips[0].start === 3, '采用对方改动后的 start=3');
}

console.log('场景3：两边都改了同一片段，两份都留着并标记冲突');
{
  const base = makeProject(
    [makeTrack('t1', [makeClip('c1', 'a1', { start: 0 })])],
    [makeAsset('a1')],
  );
  const ours = makeProject(
    [makeTrack('t1', [makeClip('c1', 'a1', { start: 2 })])],
    [makeAsset('a1')],
  );
  const theirs = makeProject(
    [makeTrack('t1', [makeClip('c1', 'a1', { start: 3 })])],
    [makeAsset('a1')],
  );
  const { project, stats } = mergeProjects(base, ours, theirs);
  const clips = project.tracks[0].clips;
  assert(clips.length === 2, '保留两份片段');
  assert(clips[0].start === 2 && clips[1].start === 3, '两份各自的 start 都在');
  assert(clips.every((c) => c.conflict === true), '两份都标记 conflict');
  assert(stats.clipConflicts === 1, '统计 1 个片段冲突');
}

console.log('场景4：一边移除的片段不回来');
{
  const base = makeProject(
    [makeTrack('t1', [makeClip('c1', 'a1'), makeClip('c2', 'a1')])],
    [makeAsset('a1')],
  );
  const ours = makeProject(
    [makeTrack('t1', [makeClip('c1', 'a1')])],
    [makeAsset('a1')],
  );
  const theirs = makeProject(
    [makeTrack('t1', [makeClip('c1', 'a1'), makeClip('c2', 'a1')])],
    [makeAsset('a1')],
  );
  const { project, stats } = mergeProjects(base, ours, theirs);
  assert(clipIds(project.tracks[0]).length === 1, '移除的片段不回来');
  assert(clipIds(project.tracks[0])[0] === 'c1', '保留未移除的片段');
  assert(stats.clipsRemoved === 1, '统计移除 1 个片段');
}

console.log('场景5：一边移除的轨道不回来');
{
  const base = makeProject(
    [makeTrack('t1', [makeClip('c1', 'a1')]), makeTrack('t2', [makeClip('c2', 'a1')])],
    [makeAsset('a1')],
  );
  const ours = makeProject(
    [makeTrack('t1', [makeClip('c1', 'a1')])],
    [makeAsset('a1')],
  );
  const theirs = makeProject(
    [makeTrack('t1', [makeClip('c1', 'a1')]), makeTrack('t2', [makeClip('c2', 'a1')])],
    [makeAsset('a1')],
  );
  const { project, stats } = mergeProjects(base, ours, theirs);
  assert(project.tracks.length === 1, '移除的轨道不回来');
  assert(project.tracks[0].id === 't1', '保留未移除的轨道');
  assert(stats.tracksRemoved === 1, '统计移除 1 个轨道');
}

console.log('场景6：对方新增片段用到的素材补进素材库');
{
  const base = makeProject(
    [makeTrack('t1', [])],
    [],
  );
  const ours = makeProject(
    [makeTrack('t1', [])],
    [],
  );
  const theirs = makeProject(
    [makeTrack('t1', [makeClip('c1', 'a9')])],
    [makeAsset('a9')],
  );
  const { project, stats } = mergeProjects(base, ours, theirs);
  assert(project.assets.some((a) => a.id === 'a9'), '素材 a9 已补入素材库');
  assert(project.tracks[0].clips[0].assetId === 'a9', '片段引用 a9');
  assert(stats.assetsAdded === 1, '统计补入 1 个素材');
}

console.log('场景7：不能留下找不到素材的空片段');
{
  const base = makeProject(
    [makeTrack('t1', [])],
    [],
  );
  const ours = makeProject(
    [makeTrack('t1', [])],
    [],
  );
  // 对方片段引用了一个双方素材库里都没有的 id
  const theirs = makeProject(
    [makeTrack('t1', [makeClip('c1', 'missing-asset')])],
    [],
  );
  const { project } = mergeProjects(base, ours, theirs);
  assert(project.tracks[0].clips.length === 0, '找不到素材的空片段被丢弃');
}

console.log('场景8：对方新增轨道保留');
{
  const base = makeProject(
    [makeTrack('t1', [makeClip('c1', 'a1')])],
    [makeAsset('a1')],
  );
  const ours = makeProject(
    [makeTrack('t1', [makeClip('c1', 'a1')])],
    [makeAsset('a1')],
  );
  const theirs = makeProject(
    [makeTrack('t1', [makeClip('c1', 'a1')]), makeTrack('t9', [makeClip('c9', 'a1')])],
    [makeAsset('a1')],
  );
  const { project, stats } = mergeProjects(base, ours, theirs);
  assert(project.tracks.length === 2, '新增轨道保留');
  assert(project.tracks[1].id === 't9', '新增轨道 id 正确');
  assert(stats.tracksAdded === 1, '统计新增 1 个轨道');
}

console.log('场景9：旧版工程（无 base）按当时工程回填基准');
{
  const oldProject = makeProject(
    [makeTrack('t1', [makeClip('c1', 'a1', { start: 5 })])],
    [makeAsset('a1')],
  );
  const base = backfillBase(oldProject);
  assert(base.tracks[0].clips[0].start === 5, '回填基准等于当时工程内容');
  assert(base.base === undefined, '回填基准不带嵌套 base');
}

console.log('场景10：自带 base 的工程优先用自带 base');
{
  const baseProject = makeProject(
    [makeTrack('t1', [makeClip('c1', 'a1', { start: 0 })])],
    [makeAsset('a1')],
  );
  const imported = makeProject(
    [makeTrack('t1', [makeClip('c1', 'a1', { start: 7 })])],
    [makeAsset('a1')],
    baseProject,
  );
  const resolved = resolveBase(imported);
  assert(resolved.tracks[0].clips[0].start === 0, '优先用自带 base');
}

console.log('场景11：轨道属性两边都改，两份都留着');
{
  const base = makeProject(
    [makeTrack('t1', [makeClip('c1', 'a1')], { volume: 0.8 })],
    [makeAsset('a1')],
  );
  const ours = makeProject(
    [makeTrack('t1', [makeClip('c1', 'a1')], { volume: 0.5 })],
    [makeAsset('a1')],
  );
  const theirs = makeProject(
    [makeTrack('t1', [makeClip('c1', 'a1')], { volume: 0.3 })],
    [makeAsset('a1')],
  );
  const { project, stats } = mergeProjects(base, ours, theirs);
  assert(project.tracks.length === 2, '保留两份轨道');
  assert(project.tracks[0].volume === 0.5, '本机轨道保留本机属性');
  assert(project.tracks[1].volume === 0.3, '对方轨道保留对方属性');
  assert(project.tracks[1].name.includes('冲突'), '对方轨道名称标出冲突');
  assert(stats.trackConflicts === 1, '统计 1 个轨道冲突');
}

console.log('场景12：合并结果带 base，可用于下一次三方合并');
{
  const base = makeProject(
    [makeTrack('t1', [makeClip('c1', 'a1')])],
    [makeAsset('a1')],
  );
  const ours = makeProject(
    [makeTrack('t1', [makeClip('c1', 'a1', { start: 2 })])],
    [makeAsset('a1')],
  );
  const theirs = makeProject(
    [makeTrack('t1', [makeClip('c1', 'a1')])],
    [makeAsset('a1')],
  );
  const { project } = mergeProjects(base, ours, theirs);
  assert(project.base !== undefined, '合并结果带 base');
  assert(project.base!.tracks[0].clips[0].start === 2, 'base 是合并后的状态');
}

if (failures > 0) {
  throw new Error(`${failures} 项断言失败`);
} else {
  console.log('\n全部断言通过');
}
