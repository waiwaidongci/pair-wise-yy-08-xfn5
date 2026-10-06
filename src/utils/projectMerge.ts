import type {
  AudioAsset,
  AudioClip,
  AudioProject,
  AudioTrack,
  TrackColor,
} from '../types/audio';

/**
 * 三方合并：base（共同祖先）+ ours（本机当前工程）+ theirs（导入的工程）。
 * 轨道与片段各自按 id 对齐，只改一边的采用那一边，两边都改的两份都留着并标记冲突，
 * 任一边移除过的不回来。片段用到的素材会一并补齐，不留找不到素材的空片段。
 */

const TRACK_SCALAR_KEYS = ['name', 'color', 'volume', 'pan', 'muted', 'solo', 'height'] as const;
type TrackScalarKey = (typeof TRACK_SCALAR_KEYS)[number];

const CLIP_COMPARE_KEYS = [
  'assetId',
  'name',
  'start',
  'duration',
  'offset',
  'fadeIn',
  'fadeOut',
  'effect',
  'effectAmount',
] as const;

function shallowEqualClip(a: AudioClip, b: AudioClip): boolean {
  if (a === b) return true;
  for (const key of CLIP_COMPARE_KEYS) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function trackPropsEqual(a: AudioTrack, b: AudioTrack): boolean {
  if (a === b) return true;
  for (const key of TRACK_SCALAR_KEYS) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/** 深拷贝工程，并剥掉嵌套的 base，避免快照里再套快照。 */
function cloneWithoutBase(project: AudioProject): AudioProject {
  const { base: _base, ...rest } = project;
  return JSON.parse(JSON.stringify(rest)) as AudioProject;
}

export interface MergeStats {
  tracksAdded: number;
  tracksRemoved: number;
  clipsAdded: number;
  clipsRemoved: number;
  clipConflicts: number;
  trackConflicts: number;
  assetsAdded: number;
}

export interface MergeResult {
  project: AudioProject;
  stats: MergeStats;
}

/** 旧版工程没有 base 字段，按当时工程内容回填一份基准。 */
export function backfillBase(project: AudioProject): AudioProject {
  return cloneWithoutBase(project);
}

function emptyStats(): MergeStats {
  return {
    tracksAdded: 0,
    tracksRemoved: 0,
    clipsAdded: 0,
    clipsRemoved: 0,
    clipConflicts: 0,
    trackConflicts: 0,
    assetsAdded: 0,
  };
}

/** 轨道属性合并：只改一边的采用那一边，两边都改的情况由调用方按冲突处理。 */
function mergeTrackProps(
  base: AudioTrack | undefined,
  ours: AudioTrack,
  theirs: AudioTrack,
): AudioTrack {
  const result: AudioTrack = { ...ours };
  for (const key of TRACK_SCALAR_KEYS) {
    if (!base) continue;
    const oursChanged = ours[key] !== base[key];
    const theirsChanged = theirs[key] !== base[key];
    if (theirsChanged && !oursChanged) {
      (result as Record<TrackScalarKey, unknown>)[key] = theirs[key];
    }
  }
  return result;
}

/** 片段三方合并：按 id 对齐，移除不回来，两边都改则两份都留着并标记冲突。 */
function mergeClips(
  baseTrack: AudioTrack | undefined,
  oursTrack: AudioTrack,
  theirsTrack: AudioTrack,
  stats: MergeStats,
): AudioClip[] {
  const baseClips = new Map((baseTrack?.clips ?? []).map((clip) => [clip.id, clip]));
  const oursClips = new Map(oursTrack.clips.map((clip) => [clip.id, clip]));
  const theirsClips = new Map(theirsTrack.clips.map((clip) => [clip.id, clip]));
  const allIds: string[] = [];
  for (const clip of oursTrack.clips) allIds.push(clip.id);
  for (const clip of theirsTrack.clips) if (!allIds.includes(clip.id)) allIds.push(clip.id);
  for (const clip of baseTrack?.clips ?? []) if (!allIds.includes(clip.id)) allIds.push(clip.id);

  const merged: AudioClip[] = [];
  for (const clipId of allIds) {
    const inBase = baseClips.has(clipId);
    const inOurs = oursClips.has(clipId);
    const inTheirs = theirsClips.has(clipId);

    // 一边移除过的不回来
    if (inBase && (!inOurs || !inTheirs)) {
      stats.clipsRemoved += 1;
      continue;
    }
    if (!inBase) {
      if (inOurs && !inTheirs) {
        merged.push(oursClips.get(clipId)!);
        stats.clipsAdded += 1;
        continue;
      }
      if (!inOurs && inTheirs) {
        merged.push(theirsClips.get(clipId)!);
        stats.clipsAdded += 1;
        continue;
      }
      // 两边都新增了同一 id：两份都留着并标记冲突
      const note = '两边都添加了同一片段';
      merged.push({ ...oursClips.get(clipId)!, conflict: true, conflictNote: note });
      merged.push({ ...theirsClips.get(clipId)!, conflict: true, conflictNote: note });
      stats.clipConflicts += 1;
      continue;
    }

    const baseClip = baseClips.get(clipId)!;
    const oursClip = oursClips.get(clipId)!;
    const theirsClip = theirsClips.get(clipId)!;
    const oursChanged = !shallowEqualClip(oursClip, baseClip);
    const theirsChanged = !shallowEqualClip(theirsClip, baseClip);
    if (oursChanged && theirsChanged) {
      const note = '两边都修改了此片段';
      merged.push({ ...oursClip, conflict: true, conflictNote: note });
      merged.push({ ...theirsClip, conflict: true, conflictNote: note });
      stats.clipConflicts += 1;
    } else if (theirsChanged) {
      merged.push(theirsClip);
    } else {
      merged.push(oursClip);
    }
  }
  return merged;
}

/** 素材合并：三方素材按 id 取并集，确保片段用到的素材都在素材库里。 */
function mergeAssets(
  base: AudioProject,
  ours: AudioProject,
  theirs: AudioProject,
): { assets: AudioAsset[]; added: number } {
  const map = new Map<string, AudioAsset>();
  for (const asset of [...base.assets, ...ours.assets, ...theirs.assets]) {
    if (!map.has(asset.id)) map.set(asset.id, asset);
  }
  const assets = Array.from(map.values());
  const oursIds = new Set(ours.assets.map((asset) => asset.id));
  const added = assets.filter((asset) => !oursIds.has(asset.id)).length;
  return { assets, added };
}

export function mergeProjects(
  base: AudioProject,
  ours: AudioProject,
  theirs: AudioProject,
): MergeResult {
  const stats = emptyStats();

  const baseTracks = new Map(base.tracks.map((track) => [track.id, track]));
  const oursTracks = new Map(ours.tracks.map((track) => [track.id, track]));
  const theirsTracks = new Map(theirs.tracks.map((track) => [track.id, track]));
  const allTrackIds: string[] = [];
  for (const track of base.tracks) allTrackIds.push(track.id);
  for (const track of ours.tracks) if (!allTrackIds.includes(track.id)) allTrackIds.push(track.id);
  for (const track of theirs.tracks) if (!allTrackIds.includes(track.id)) allTrackIds.push(track.id);

  const mergedTracks: AudioTrack[] = [];
  for (const trackId of allTrackIds) {
    const inBase = baseTracks.has(trackId);
    const inOurs = oursTracks.has(trackId);
    const inTheirs = theirsTracks.has(trackId);

    // 一边移除过的不回来
    if (inBase && (!inOurs || !inTheirs)) {
      stats.tracksRemoved += 1;
      continue;
    }
    if (!inBase) {
      if (inOurs && !inTheirs) {
        mergedTracks.push(oursTracks.get(trackId)!);
        stats.tracksAdded += 1;
        continue;
      }
      if (!inOurs && inTheirs) {
        mergedTracks.push(theirsTracks.get(trackId)!);
        stats.tracksAdded += 1;
        continue;
      }
    }

    const baseTrack = baseTracks.get(trackId);
    const oursTrack = oursTracks.get(trackId)!;
    const theirsTrack = theirsTracks.get(trackId)!;
    const oursChanged = baseTrack ? !trackPropsEqual(oursTrack, baseTrack) : true;
    const theirsChanged = baseTrack ? !trackPropsEqual(theirsTrack, baseTrack) : true;

    if (oursChanged && theirsChanged) {
      // 轨道属性两边都改了：两份都留着。本机轨道保留合并后的片段，
      // 对方轨道原样保留并在名称上标出冲突，片段冲突在本机轨道里标记。
      const mergedClips = mergeClips(baseTrack, oursTrack, theirsTrack, stats);
      mergedTracks.push({ ...oursTrack, clips: mergedClips });
      mergedTracks.push({
        ...theirsTrack,
        name: `${theirsTrack.name} · 冲突`,
        clips: theirsTrack.clips,
      });
      stats.trackConflicts += 1;
    } else {
      const mergedProps = mergeTrackProps(baseTrack, oursTrack, theirsTrack);
      mergedTracks.push({
        ...mergedProps,
        clips: mergeClips(baseTrack, oursTrack, theirsTrack, stats),
      });
    }
  }

  const { assets, added } = mergeAssets(base, ours, theirs);
  stats.assetsAdded = added;

  // 兜底：片段用到的素材必须在素材库里，丢掉找不到素材的空片段
  const assetIds = new Set(assets.map((asset) => asset.id));
  const safeTracks = mergedTracks.map((track) => ({
    ...track,
    clips: track.clips.filter((clip) => assetIds.has(clip.assetId)),
  }));

  const mergedWithoutBase: AudioProject = {
    ...ours,
    tracks: safeTracks,
    assets,
    updatedAt: Date.now(),
  };
  const project: AudioProject = {
    ...mergedWithoutBase,
    base: cloneWithoutBase(mergedWithoutBase),
  };

  return { project, stats };
}

/** 校验导入的工程是否为受支持的 v1 格式。 */
export function isSupportedProject(value: unknown): value is AudioProject {
  if (typeof value !== 'object' || value === null) return false;
  const project = value as Partial<AudioProject>;
  return (
    project.version === 1 &&
    Array.isArray(project.tracks) &&
    Array.isArray(project.assets)
  );
}

/** 从导入的工程里取共同祖先：优先用文件自带的 base，否则按当时工程回填。 */
export function resolveBase(imported: AudioProject): AudioProject {
  if (imported.base && isSupportedProject(imported.base)) {
    return imported.base;
  }
  return backfillBase(imported);
}

export type { TrackColor };
