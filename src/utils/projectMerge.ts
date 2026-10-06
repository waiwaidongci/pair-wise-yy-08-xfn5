import type {
  AudioAsset,
  AudioClip,
  AudioProject,
  AudioTrack,
  ClipConflict,
  ClipConflictKind,
  MergeReport,
  ProjectBundle,
} from '../types/audio';
import { isSyntheticAsset } from './syntheticAudio';

/**
 * 工程三路合并（base / 本机 / 对方）。
 *
 * 规则（轨道与片段各自独立合并）：
 * - 只有一边相对 base 改动过：采用改动的一边；
 * - 两边都改且内容不同：片段保留两份并打冲突标记；轨道参数取本机值并在轨道与片段上标冲突；
 * - 一边移除（删片段 / 删轨）：删除优先，绝不复活；另一边同时改过则计入删改冲突报告；
 * - 对方片段引用的素材并入素材库，id 撞车自动换 id 并只重映射对方片段；
 * - 实在找不到的素材生成可播放的占位素材，保证没有悬空片段。
 */

const TRACK_KEYS = ['name', 'color', 'volume', 'pan', 'muted', 'solo', 'height'] as const;
type TrackScalarKey = (typeof TRACK_KEYS)[number];

const TRACK_FIELD_LABELS: Record<TrackScalarKey, string> = {
  name: '名称',
  color: '颜色',
  volume: '音量',
  pan: '声像',
  muted: '静音',
  solo: '独奏',
  height: '高度',
};

const CLIP_KEYS = [
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

const PROJECT_KEYS = [
  'name',
  'bpm',
  'snap',
  'loopEnabled',
  'loopStart',
  'loopEnd',
  'pixelsPerSecond',
] as const;

const FALLBACK_TRACK: Omit<AudioTrack, 'id'> = {
  name: '合并轨道',
  color: '#2563eb',
  volume: 0.72,
  pan: 0,
  muted: false,
  solo: false,
  height: 112,
  clips: [],
};

export function cloneProject(project: AudioProject): AudioProject {
  if (typeof structuredClone === 'function') return structuredClone(project);
  return JSON.parse(JSON.stringify(project)) as AudioProject;
}

/** 基准只保存干净内容：去掉历史冲突标记，合并时会重新检测 */
export function stripProjectConflicts(project: AudioProject): AudioProject {
  const cloned = cloneProject(project);
  for (const track of cloned.tracks) {
    delete track.trackConflicts;
    for (const clip of track.clips) {
      delete clip.conflict;
    }
  }
  return cloned;
}

function mergeUid(prefix: string): string {
  return `${prefix}-merge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6;
  return Object.is(a, b);
}

interface ClipLocation {
  trackId: string;
  clip: AudioClip;
}

function indexClips(project: AudioProject): Map<string, ClipLocation> {
  const index = new Map<string, ClipLocation>();
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      index.set(clip.id, { trackId: track.id, clip });
    }
  }
  return index;
}

function indexTracks(project: AudioProject): Map<string, AudioTrack> {
  return new Map(project.tracks.map((track) => [track.id, track]));
}

function clipStateEqual(a: AudioClip, b: AudioClip): boolean {
  return CLIP_KEYS.every((key) => sameValue(a[key], b[key]));
}

function clipChanged(
  baseClip: AudioClip,
  currentClip: AudioClip,
  baseTrackId: string,
  currentTrackId: string,
): boolean {
  return baseTrackId !== currentTrackId || !clipStateEqual(baseClip, currentClip);
}

function trackChanged(baseTrack: AudioTrack, currentTrack: AudioTrack): boolean {
  return TRACK_KEYS.some((key) => !sameValue(baseTrack[key], currentTrack[key]));
}

function assetSignature(asset: AudioAsset): string {
  return [
    asset.source,
    asset.mimeType,
    asset.size ?? '',
    asset.duration.toFixed(4),
    asset.dataUrl ?? '',
  ].join('|');
}

function emptyReport(legacyBase: boolean): MergeReport {
  return {
    clipConflicts: 0,
    trackConflicts: 0,
    deleteModifyConflicts: 0,
    moveDeleteConflicts: 0,
    addedAssets: 0,
    missingAssets: 0,
    legacyBase,
  };
}

export interface MergeOptions {
  /** 导入的是旧版 v1 纯工程，base 已用该工程回填 */
  legacyBase: boolean;
}

export function mergeProjects(
  localProject: AudioProject,
  incomingProject: AudioProject,
  baseProject: AudioProject,
  options: MergeOptions,
): { project: AudioProject; report: MergeReport } {
  const local = stripProjectConflicts(localProject);
  const incoming = stripProjectConflicts(incomingProject);
  const base = stripProjectConflicts(baseProject);
  const report = emptyReport(options.legacyBase);

  const localTracks = indexTracks(local);
  const incomingTracks = indexTracks(incoming);
  const baseTracks = indexTracks(base);

  // ---- 1. 轨道顺序：base 顺序 → 本机新增 → 对方新增 ----
  const trackOrder: string[] = [];
  for (const track of base.tracks) trackOrder.push(track.id);
  for (const track of local.tracks) {
    if (!baseTracks.has(track.id) && !trackOrder.includes(track.id)) trackOrder.push(track.id);
  }
  for (const track of incoming.tracks) {
    if (!baseTracks.has(track.id) && !trackOrder.includes(track.id)) trackOrder.push(track.id);
  }

  // ---- 2. 轨道逐字段三路合并 ----
  const mergedTracks: AudioTrack[] = [];
  for (const trackId of trackOrder) {
    const lt = localTracks.get(trackId);
    const it = incomingTracks.get(trackId);
    const bt = baseTracks.get(trackId);

    let kept: AudioTrack | null = null;
    let conflictFields: string[] = [];

    if (!bt) {
      // 新增轨
      if (lt && it) {
        kept = cloneTrack(lt);
        for (const key of TRACK_KEYS) {
          if (!sameValue(lt[key], it[key])) {
            conflictFields.push(TRACK_FIELD_LABELS[key]);
          }
        }
      } else if (lt) {
        kept = cloneTrack(lt);
      } else if (it) {
        kept = cloneTrack(it);
      }
    } else if (lt && it) {
      // 两边都在：字段级三路合并
      kept = cloneTrack(lt);
      for (const key of TRACK_KEYS) {
        const localChanged = !sameValue(lt[key], bt[key]);
        const incomingChanged = !sameValue(it[key], bt[key]);
        if (!localChanged) {
          kept[key] = it[key] as never;
        } else if (incomingChanged && !sameValue(lt[key], it[key])) {
          conflictFields.push(TRACK_FIELD_LABELS[key]);
        }
      }
    } else if (lt) {
      // 对方删轨：本地改没改都不复活；本地改过属于删改冲突
      if (trackChanged(bt, lt)) report.deleteModifyConflicts += 1;
    } else if (it) {
      // 本机删轨
      if (trackChanged(bt, it)) report.deleteModifyConflicts += 1;
    }
    // 两边都删：直接丢弃

    if (kept) {
      kept.clips = [];
      if (conflictFields.length) {
        kept.trackConflicts = conflictFields;
        report.trackConflicts += 1;
      }
      mergedTracks.push(kept);
    }
  }

  // 极端情况下所有轨道都被删，给悬空片段准备一个落点
  if (mergedTracks.length === 0) {
    mergedTracks.push({ ...FALLBACK_TRACK, id: mergeUid('track'), clips: [] });
  }
  const mergedTrackIds = new Set(mergedTracks.map((track) => track.id));

  // ---- 3. 先做素材池合并，得到"对方片段素材 id 重映射表" ----
  const assetPool = new Map<string, AudioAsset>();
  // base 里的素材先入池（两边都没删引用时素材保留；后续两边内容不同再处理）
  for (const asset of base.assets) {
    if (!isSyntheticAsset(asset.id)) assetPool.set(asset.id, cloneAsset(asset));
  }
  for (const asset of local.assets) assetPool.set(asset.id, cloneAsset(asset));
  const incomingAssetRemap = new Map<string, string>();
  for (const asset of incoming.assets) {
    if (isSyntheticAsset(asset.id)) continue;
    const existing = assetPool.get(asset.id);
    if (!existing) {
      assetPool.set(asset.id, cloneAsset(asset));
      report.addedAssets += 1;
    } else if (assetSignature(existing) !== assetSignature(asset)) {
      // 同 id 不同内容：给对方素材换 id，本机片段继续引用本机素材
      const newId = mergeUid('asset');
      assetPool.set(newId, { ...cloneAsset(asset), id: newId });
      incomingAssetRemap.set(asset.id, newId);
      report.addedAssets += 1;
    }
  }

  // ---- 4. 片段全局三路合并（跨轨移动以 base 所在轨为准比较） ----
  const baseClips = indexClips(base);
  const localClips = indexClips(local);
  const incomingClips = indexClips(incoming);

  const clipIdOrder: string[] = [];
  const collectOrder = (project: AudioProject) => {
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (!clipIdOrder.includes(clip.id)) clipIdOrder.push(clip.id);
      }
    }
  };
  collectOrder(base);
  collectOrder(local);
  collectOrder(incoming);

  const placeClip = (
    clip: AudioClip,
    preferredTrackId: string,
    fallbackTrackId?: string,
  ): void => {
    let targetTrackId: string;
    let extraConflict: ClipConflict | null = null;
    if (mergedTrackIds.has(preferredTrackId)) {
      targetTrackId = preferredTrackId;
    } else if (fallbackTrackId && mergedTrackIds.has(fallbackTrackId)) {
      targetTrackId = fallbackTrackId;
      extraConflict = {
        kind: 'moved-away-deleted',
        note: '原轨道被一边删除，片段已保留在它另一边所在的轨道上',
      };
    } else {
      targetTrackId = mergedTracks[0].id;
      extraConflict = {
        kind: 'missing-track',
        note: '片段所属轨道已在合并中删除，暂存于此轨道，请人工确认',
      };
    }
    if (extraConflict && !clip.conflict) clip.conflict = extraConflict;
    const target = mergedTracks.find((track) => track.id === targetTrackId);
    target?.clips.push(clip);
  };

  const BOTH_EDITED_NOTE = '本机与对方都修改了这个片段，两份均已保留，请人工取舍';
  const BOTH_ADDED_NOTE = '两边都新增了相同 ID 的片段，两份均已保留，请人工取舍';

  for (const clipId of clipIdOrder) {
    const bl = baseClips.get(clipId);
    const ll = localClips.get(clipId);
    const il = incomingClips.get(clipId);

    if (!bl) {
      // base 没有：新增片段
      if (ll && il) {
        if (clipStateEqual(ll.clip, il.clip) && ll.trackId === il.trackId) {
          placeClip(cloneClip(ll.clip, incomingAssetRemap, false), ll.trackId, il.trackId);
        } else {
          report.clipConflicts += 1;
          placeClip(
            withConflict(cloneClip(ll.clip, incomingAssetRemap, false), 'clip-both-edited', BOTH_ADDED_NOTE),
            ll.trackId,
            il.trackId,
          );
          placeClip(
            withConflict(
              {
                ...cloneClip(il.clip, incomingAssetRemap, true),
                id: mergeUid('clip'),
                name: `${il.clip.name}（对方版本）`,
              },
              'clip-both-edited',
              BOTH_ADDED_NOTE,
            ),
            il.trackId,
            ll.trackId,
          );
        }
      } else if (ll) {
        placeClip(cloneClip(ll.clip, incomingAssetRemap, false), ll.trackId);
      } else if (il) {
        placeClip(cloneClip(il.clip, incomingAssetRemap, true), il.trackId);
      }
      continue;
    }

    if (ll && il) {
      const localChanged = clipChanged(bl.clip, ll.clip, bl.trackId, ll.trackId);
      const incomingChanged = clipChanged(bl.clip, il.clip, bl.trackId, il.trackId);
      if (localChanged && incomingChanged) {
        if (clipStateEqual(ll.clip, il.clip) && ll.trackId === il.trackId) {
          // 两边改成一样：保留一份
          placeClip(cloneClip(ll.clip, incomingAssetRemap, false), ll.trackId, il.trackId);
        } else {
          report.clipConflicts += 1;
          placeClip(
            withConflict(cloneClip(ll.clip, incomingAssetRemap, false), 'clip-both-edited', BOTH_EDITED_NOTE),
            ll.trackId,
            il.trackId,
          );
          placeClip(
            withConflict(
              {
                ...cloneClip(il.clip, incomingAssetRemap, true),
                id: mergeUid('clip'),
                name: `${il.clip.name}（对方版本）`,
              },
              'clip-both-edited',
              BOTH_EDITED_NOTE,
            ),
            il.trackId,
            ll.trackId,
          );
        }
      } else if (incomingChanged) {
        placeClip(cloneClip(il.clip, incomingAssetRemap, true), il.trackId, ll.trackId);
      } else {
        // 只有本机改，或两边都没动
        placeClip(cloneClip(ll.clip, incomingAssetRemap, false), ll.trackId, il.trackId);
      }
      continue;
    }

    // 只剩一边有：另一边删过。删除优先，不复活。
    // 例外：一边删了片段原在的轨道，另一边已经把片段挪到存活轨道上——
    // 删掉的是旧轨、片段并未"复活"，保留到新轨并标出移动/删除冲突。
    const moveDeleteNote = '片段被一边移走、原轨道被另一边删除，已保留在新轨道上，请确认';
    if (ll && !il && ll.trackId !== bl.trackId && !incomingTracks.has(bl.trackId) && mergedTrackIds.has(ll.trackId)) {
      report.moveDeleteConflicts += 1;
      placeClip(
        withConflict(cloneClip(ll.clip, incomingAssetRemap, false), 'moved-away-deleted', moveDeleteNote),
        ll.trackId,
      );
      continue;
    }
    if (il && !ll && il.trackId !== bl.trackId && !localTracks.has(bl.trackId) && mergedTrackIds.has(il.trackId)) {
      report.moveDeleteConflicts += 1;
      placeClip(
        withConflict(cloneClip(il.clip, incomingAssetRemap, true), 'moved-away-deleted', moveDeleteNote),
        il.trackId,
      );
      continue;
    }

    // 存活方同时改过则计入删改冲突报告（删除仍优先，不复活）
    if (ll && clipChanged(bl.clip, ll.clip, bl.trackId, ll.trackId)) {
      report.deleteModifyConflicts += 1;
    }
    if (il && clipChanged(bl.clip, il.clip, bl.trackId, il.trackId)) {
      report.deleteModifyConflicts += 1;
    }
  }

  // ---- 5. 轨道参数冲突传播到该轨片段（不覆盖片段自身冲突） ----
  for (const track of mergedTracks) {
    if (!track.trackConflicts?.length) continue;
    const note = `轨道参数（${track.trackConflicts.join('、')}）两边修改不同，已保留本机设置`;
    for (const clip of track.clips) {
      if (!clip.conflict) {
        clip.conflict = { kind: 'track-both-edited', note };
      }
    }
  }

  // ---- 6. 悬空素材：谁都没带的素材生成可播放占位，杜绝空片段 ----
  const missingAssetRemap = new Map<string, string>();
  for (const track of mergedTracks) {
    for (const clip of track.clips) {
      if (assetPool.has(clip.assetId) || isSyntheticAsset(clip.assetId)) continue;
      let placeholderId = missingAssetRemap.get(clip.assetId);
      if (!placeholderId) {
        placeholderId = mergeUid('missing-asset');
        const requiredDuration = Math.max(2, clip.offset + clip.duration);
        const placeholder: AudioAsset = {
          id: placeholderId,
          name: `占位素材（原素材 ${clip.assetId} 缺失）`,
          source: 'imported',
          duration: requiredDuration,
          mimeType: 'audio/wav',
          // 不带 dataUrl：播放与波形会走内置合成兜底，不会再出现找不到素材的空片段
        };
        assetPool.set(placeholderId, placeholder);
        missingAssetRemap.set(clip.assetId, placeholderId);
        report.missingAssets += 1;
      }
      clip.assetId = placeholderId;
    }
  }

  // ---- 7. 片段排序 ----
  for (const track of mergedTracks) {
    track.clips.sort((a, b) => a.start - b.start || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  // ---- 8. 工程级参数三路合并，两边都改时保守取本机 ----
  const mergedScalars: Pick<AudioProject, (typeof PROJECT_KEYS)[number]> = {
    name: local.name,
    bpm: local.bpm,
    snap: local.snap,
    loopEnabled: local.loopEnabled,
    loopStart: local.loopStart,
    loopEnd: local.loopEnd,
    pixelsPerSecond: local.pixelsPerSecond,
  };
  for (const key of PROJECT_KEYS) {
    const localChanged = !sameValue(local[key], base[key]);
    const incomingChanged = !sameValue(incoming[key], base[key]);
    if (!localChanged && incomingChanged) {
      (mergedScalars as Record<string, unknown>)[key] = incoming[key];
    }
  }

  const assets = [...assetPool.values()];
  const project: AudioProject = {
    version: 1,
    ...mergedScalars,
    tracks: mergedTracks,
    assets,
    updatedAt: Date.now(),
  };

  return { project, report };
}

function cloneTrack(track: AudioTrack): AudioTrack {
  return { ...track, clips: track.clips.map((clip) => ({ ...clip })) };
}

function cloneClip(
  clip: AudioClip,
  incomingAssetRemap: Map<string, string>,
  fromIncoming: boolean,
): AudioClip {
  const cloned = { ...clip };
  if (fromIncoming && incomingAssetRemap.has(cloned.assetId)) {
    cloned.assetId = incomingAssetRemap.get(cloned.assetId) as string;
  }
  delete cloned.conflict;
  return cloned;
}

function cloneAsset(asset: AudioAsset): AudioAsset {
  return { ...asset };
}

function withConflict(clip: AudioClip, kind: ClipConflictKind, note: string): AudioClip {
  const conflict: ClipConflict = { kind, note };
  return { ...clip, conflict };
}

// ---------- 导入文件解析 / 导出包 ----------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isValidProject(value: unknown): value is AudioProject {
  if (!isObject(value)) return false;
  if (value.version !== 1) return false;
  if (typeof value.name !== 'string') return false;
  if (!Array.isArray(value.tracks) || !Array.isArray(value.assets)) return false;
  return value.tracks.every(
    (track) =>
      isObject(track) &&
      typeof track.id === 'string' &&
      typeof track.name === 'string' &&
      Array.isArray(track.clips),
  );
}

export interface ParsedImport {
  project: AudioProject;
  base: AudioProject;
  legacyBase: boolean;
}

export function parseImportFile(text: string): ParsedImport {
  const json: unknown = JSON.parse(text);
  // 旧版 v1：导出的就是工程本体。按"当时的工程"回填一份基准。
  if (isValidProject(json)) {
    return { project: json, base: cloneProject(json), legacyBase: true };
  }
  if (
    isObject(json) &&
    json.kind === 'waveforge-project' &&
    json.bundleVersion === 2 &&
    isValidProject(json.project) &&
    isValidProject(json.base)
  ) {
    const bundle = json as unknown as ProjectBundle;
    return { project: bundle.project, base: bundle.base, legacyBase: false };
  }
  throw new Error('不是有效的 WaveForge 工程文件');
}

export function createProjectBundle(project: AudioProject, base: AudioProject): ProjectBundle {
  return {
    kind: 'waveforge-project',
    bundleVersion: 2,
    project: stripProjectConflicts(project),
    base: stripProjectConflicts(base),
    exportedAt: Date.now(),
  };
}
