import {
  Download,
  FolderOpen,
  GraphicEq,
  Save,
  Undo,
} from '@mui/icons-material';
import { Alert, Button, Stack, TextField, Typography } from '@mui/material';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AssetLibrary } from '../components/AssetLibrary';
import { ClipInspector } from '../components/ClipInspector';
import { TrackTimeline } from '../components/TrackTimeline';
import { TransportBar } from '../components/TransportBar';
import { useStudioStore } from '../stores/studioStore';
import type { AudioProject } from '../types/audio';
import { isSupportedProject } from '../utils/projectMerge';
import { audioEngine } from '../utils/audioEngine';

export function StudioPage() {
  const project = useStudioStore((state) => state.project);
  const isPlaying = useStudioStore((state) => state.isPlaying);
  const playhead = useStudioStore((state) => state.playhead);
  const setPlaying = useStudioStore((state) => state.setPlaying);
  const setPlayhead = useStudioStore((state) => state.setPlayhead);
  const setProjectName = useStudioStore((state) => state.setProjectName);
  const mergeImport = useStudioStore((state) => state.mergeImport);
  const undoImport = useStudioStore((state) => state.undoImport);
  const canUndoImport = useStudioStore((state) => state.preImportSnapshot !== null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [recordingPulse, setRecordingPulse] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const mixKey = useMemo(
    () =>
      JSON.stringify(
        project.tracks.map((track) => ({
          id: track.id,
          volume: track.volume,
          pan: track.pan,
          muted: track.muted,
          solo: track.solo,
          clips: track.clips.map((clip) => ({
            id: clip.id,
            start: clip.start,
            duration: clip.duration,
            offset: clip.offset,
            fadeIn: clip.fadeIn,
            fadeOut: clip.fadeOut,
            effect: clip.effect,
            amount: clip.effectAmount,
          })),
        })),
      ),
    [project.tracks],
  );
  const wasPlayingBeforeMixChange = useRef(false);

  const beginPlayback = async (from: number) => {
    try {
      const latest = useStudioStore.getState();
      await audioEngine.play(latest.project, Math.max(0, from), () => {
        const state = useStudioStore.getState();
        if (state.project.loopEnabled) {
          void beginPlayback(state.project.loopStart);
        } else {
          setPlaying(false);
          setPlayhead(0);
        }
      });
      setPlaying(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '音频播放初始化失败');
      setPlaying(false);
    }
  };

  const pause = () => {
    const next = audioEngine.getPlayhead();
    audioEngine.stop();
    setPlayhead(next);
    setPlaying(false);
  };

  const stop = () => {
    audioEngine.stop();
    setPlayhead(project.loopEnabled ? project.loopStart : 0);
    setPlaying(false);
  };

  useEffect(() => {
    if (!isPlaying) return;
    let frame = 0;
    let lastUpdate = 0;
    const tick = (time: number) => {
      const current = audioEngine.getPlayhead();
      const state = useStudioStore.getState();
      if (state.project.loopEnabled && current >= state.project.loopEnd) {
        audioEngine.stop();
        void beginPlayback(state.project.loopStart);
        return;
      }
      if (time - lastUpdate > 33) {
        setPlayhead(current);
        lastUpdate = time;
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [isPlaying, setPlayhead]);

  useEffect(() => {
    if (!isPlaying) {
      wasPlayingBeforeMixChange.current = false;
      return;
    }
    if (wasPlayingBeforeMixChange.current) {
      const current = audioEngine.getPlayhead();
      audioEngine.stop();
      void beginPlayback(current);
    }
    wasPlayingBeforeMixChange.current = true;
  }, [mixKey]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, [contenteditable="true"]')) return;
      if (event.code === 'Space') {
        event.preventDefault();
        isPlaying ? pause() : void beginPlayback(playhead);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, playhead]);

  useEffect(
    () => () => {
      audioEngine.stop();
    },
    [],
  );

  const saveProject = () => {
    // 导出时写入共同祖先基准：已有基准则沿用，否则以当前工程为基准。
    // 后续同事离线改完再导回来时，就靠这份基准做三方合并。
    const exportData: AudioProject = {
      ...project,
      base: project.base ?? JSON.parse(JSON.stringify(project)),
    };
    const content = JSON.stringify(exportData, null, 2);
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${project.name.replaceAll('/', '-')}.waveforge.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    useStudioStore.getState().markSaved();
    setMessage('工程 JSON 已导出，轨道与效果参数可在其他浏览器中继续编辑。');
  };

  const importProject = async (file?: File) => {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!isSupportedProject(parsed)) {
        throw new Error('不是有效的 WaveForge v1 工程文件');
      }
      audioEngine.stop();
      const stats = mergeImport(parsed);
      const parts: string[] = [];
      if (stats.tracksAdded) parts.push(`新增轨道 ${stats.tracksAdded}`);
      if (stats.tracksRemoved) parts.push(`移除轨道 ${stats.tracksRemoved}`);
      if (stats.clipsAdded) parts.push(`新增片段 ${stats.clipsAdded}`);
      if (stats.clipsRemoved) parts.push(`移除片段 ${stats.clipsRemoved}`);
      if (stats.clipConflicts) parts.push(`片段冲突 ${stats.clipConflicts}（已保留双方版本并标记）`);
      if (stats.trackConflicts) parts.push(`轨道冲突 ${stats.trackConflicts}（已保留双方版本）`);
      if (stats.assetsAdded) parts.push(`补入素材 ${stats.assetsAdded}`);
      setMessage(
        parts.length
          ? `已合并工程：${parsed.name}。${parts.join('，')}。`
          : `已合并工程：${parsed.name}，两边没有差异。`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '工程导入失败');
    }
  };

  return (
    <div className="studio-page">
      <header className="studio-heading">
        <div>
          <Typography className="eyebrow">BROWSER AUDIO WORKSTATION</Typography>
          <TextField
            variant="standard"
            value={project.name}
            onChange={(event) => setProjectName(event.target.value)}
            className="project-name"
            inputProps={{ 'aria-label': '工程名称' }}
          />
          <Stack direction="row" alignItems="center" spacing={1}>
            <span className="autosave-dot" />
            <Typography variant="caption" color="text.secondary">
              轨道和效果参数自动保存到 localStorage
            </Typography>
          </Stack>
        </div>
        <Stack direction="row" spacing={1}>
          <Button
            variant="outlined"
            startIcon={<FolderOpen />}
            onClick={() => importInputRef.current?.click()}
          >
            导入工程
          </Button>
          <Button
            variant="outlined"
            startIcon={<Undo />}
            disabled={!canUndoImport}
            onClick={undoImport}
          >
            撤销导入
          </Button>
          <Button variant="outlined" startIcon={<Download />} onClick={saveProject}>
            导出工程
          </Button>
          <Button variant="contained" startIcon={<Save />} onClick={saveProject}>
            保存
          </Button>
          <input
            ref={importInputRef}
            hidden
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              void importProject(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
        </Stack>
      </header>

      <TransportBar
        recording={recordingPulse}
        onPlay={() => void beginPlayback(playhead)}
        onPause={pause}
        onStop={stop}
        onRecord={() => {
          setRecordingPulse(true);
          window.setTimeout(() => setRecordingPulse(false), 1200);
          setMessage('录音入口位于左侧素材库，点击红色录音按钮即可开始。');
        }}
        onSaveProject={saveProject}
      />

      {message && (
        <Alert severity="info" className="studio-message" onClose={() => setMessage(null)}>
          {message}
        </Alert>
      )}

      {canUndoImport && (
        <Alert
          severity="warning"
          className="studio-message"
          action={
            <Button color="inherit" size="small" onClick={undoImport}>
              撤销导入
            </Button>
          }
        >
          已按轨道与片段合并导入，可随时撤销回导入前的样子。
        </Alert>
      )}

      <main className="studio-workspace">
        <AssetLibrary />
        <TrackTimeline />
        <ClipInspector />
      </main>
    </div>
  );
}
