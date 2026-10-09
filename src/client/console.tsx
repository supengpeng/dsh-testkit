/**
 * 测试控制台：挂在会话视图环的 `conversation.view`（Chat / Trajectory 旁）。
 *
 * 数据**不在 client 侧持有**：场景与运行记录的真相在 host 半，
 * 这里只做投影与触发（见 docs/ARCHITECTURE.md §6.3），经 src/bridge.ts 的
 * HTTP 通道读取。
 */

import * as React from 'react'

import { callHost, type RunPayload, type ScenarioListPayload } from './bridge'

export interface ConsoleProps {
  t?: (key: string) => string
}

const S = {
  page: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px',
    padding: '16px 20px',
    height: '100%',
    minHeight: 0,
    overflowY: 'auto' as const,
    color: 'var(--dsw-alias-label-primary, #e6e6e6)',
    fontSize: '13px',
  },
  head: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' as const },
  title: { margin: 0, fontSize: '16px', fontWeight: 500 },
  subtitle: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #888)' },
  toolbar: { display: 'flex', gap: '8px', flexWrap: 'wrap' as const },
  button: {
    font: 'inherit',
    cursor: 'pointer',
    border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.35))',
    background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))',
    color: 'inherit',
    borderRadius: '14px',
    padding: '3px 12px',
  },
  notice: (tone: 'error' | 'warn') => ({
    border: `1px solid var(--dsw-alias-state-${tone === 'error' ? 'error' : 'warning'}-primary, ${
      tone === 'error' ? '#d9534f' : '#d9a24f'
    })`,
    borderRadius: '8px',
    padding: '8px 10px',
    fontSize: '12px',
    whiteSpace: 'pre-wrap' as const,
    color: `var(--dsw-alias-state-${tone === 'error' ? 'error' : 'warning'}-primary, ${
      tone === 'error' ? '#d9534f' : '#d9a24f'
    })`,
  }),
  empty: { color: 'var(--dsw-alias-label-tertiary, #888)', padding: '12px 0' },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '12px' },
  th: {
    textAlign: 'left' as const,
    padding: '6px 8px',
    borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))',
    color: 'var(--dsw-alias-label-secondary, #aaa)',
    fontWeight: 500,
  },
  td: {
    padding: '6px 8px',
    borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14))',
    verticalAlign: 'top' as const,
  },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  section: { margin: 0, fontSize: '13px', fontWeight: 500 },
} as const

const VERDICT_MARK: Record<string, string> = {
  passed: '✅',
  failed: '❌',
  skipped: '⏭️',
  errored: '💥',
}

export function ConsoleView(props: ConsoleProps): React.ReactElement {
  const t = props.t ?? ((key: string): string => key)
  const [list, setList] = React.useState<ScenarioListPayload | null>(null)
  const [run, setRun] = React.useState<RunPayload | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<'idle' | 'loading' | 'running'>('idle')

  const refresh = React.useCallback(async (): Promise<void> => {
    setBusy('loading')
    setError(null)
    try {
      setList(await callHost<ScenarioListPayload>('list'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy('idle')
    }
  }, [])

  const runAll = React.useCallback(async (): Promise<void> => {
    setBusy('running')
    setError(null)
    try {
      setRun(await callHost<RunPayload>('run', {}))
      setList(await callHost<ScenarioListPayload>('list'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy('idle')
    }
  }, [])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const scenarios = list?.scenarios ?? []
  const invalid = list?.invalid ?? []

  return (
    <div style={S.page}>
      <div style={S.head}>
        <h2 style={S.title}>{t('title')}</h2>
        <p style={S.subtitle}>{t('subtitle')}</p>
      </div>

      <div style={S.toolbar}>
        <button type="button" style={S.button} disabled={busy !== 'idle'} onClick={() => void refresh()}>
          {busy === 'loading' ? t('running') : t('refresh')}
        </button>
        <button
          type="button"
          style={S.button}
          disabled={busy !== 'idle' || scenarios.length === 0}
          onClick={() => void runAll()}
        >
          {busy === 'running' ? t('running') : t('runAll')}
        </button>
        {list !== null && (
          <span style={S.subtitle}>
            {list.dir} · {scenarios.length}
          </span>
        )}
      </div>

      {error !== null && <div style={S.notice('error')}>{error}</div>}

      {run !== null && (
        <div style={S.notice('warn')}>
          <strong>{run.runId}</strong>
          {' — '}
          ✅ {run.totals.passed} · ❌ {run.totals.failed} · ⏭️ {run.totals.skipped} · 💥{' '}
          {run.totals.errored}
          {run.reportPath !== null ? `\n${run.reportPath}` : ''}
        </div>
      )}

      {scenarios.length === 0 && error === null ? (
        <div style={S.empty}>{busy === 'idle' ? t('empty') : t('running')}</div>
      ) : (
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>ID</th>
              <th style={S.th}>{t('kind')}</th>
              <th style={S.th}>{t('status')}</th>
              <th style={S.th}>{t('title_field')}</th>
              <th style={S.th}>run</th>
            </tr>
          </thead>
          <tbody>
            {scenarios.map((row) => {
              const done = run?.cases.find((c) => c.id === row.id)
              return (
                <tr key={row.id}>
                  <td style={{ ...S.td, ...S.mono }}>{row.id}</td>
                  <td style={S.td}>{row.kind}</td>
                  <td style={S.td}>{row.status}</td>
                  <td style={S.td}>{row.title}</td>
                  <td style={S.td}>{done ? (VERDICT_MARK[done.verdict] ?? done.verdict) : ''}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {invalid.length > 0 && (
        <div>
          <p style={S.section}>
            {t('invalid')} — {invalid.length}
          </p>
          {invalid.map((item) => (
            <div key={item.file} style={S.notice('warn')}>
              <span style={S.mono}>{item.file}</span>
              {'\n'}
              {item.detail}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
