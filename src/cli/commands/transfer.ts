/**
 * 传输类子命令：`export`（本仓 → CI / touchstone）与 `import`（touchstone → 本仓草稿）。
 *
 * ## 一条边界：`import` 只产**草稿 / 提案**，绝不直接写 `cases/`
 *
 * 与 `/testkit import` 同源：转换出来的东西必须走**提炼闸门**（人批准才落地）。
 * CLI 不是后门——它能自动化"把外部 issue 转成候选"，但不能自动化"批准"。
 * 想只看看结果而不登记提案，用 `--dry-run`。
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { CaseRegistry } from '../../cases/registry.js'
import { PipelineStore } from '../../pipeline/index.js'
import { exportScenariosToFile } from '../../export/write.js'
import { latestRunJson } from '../../surface/runs.js'
import { exportBugReports, parseCaseMd } from '../../touchstone/index.js'
import { has, oneTrimmed, type OptionSpec, type ParsedOptions } from '../args.js'
import type { CliContext } from '../context.js'
import { EXIT, type ExitCode } from '../exit.js'
import { emitError, emitJson, line } from '../io.js'
import { isDirectory } from './run.js'

/** 导出物里写进 `node:test` 的默认超时（与 runner 的默认值一致）。 */
const DEFAULT_TIMEOUT_MS = 30_000

export const EXPORT_OPTIONS: readonly OptionSpec[] = [
  {
    name: 'format',
    kind: 'value',
    placeholder: '<node-test|touchstone>',
    help: '导出目标（缺省 node-test：自包含 CI 用例）',
  },
  { name: 'out', alias: 'o', kind: 'value', placeholder: '<dir>', help: '输出目录' },
  { name: 'run-id', kind: 'value', placeholder: '<id>', help: 'touchstone 目标：指定运行记录（缺省取最近一次）' },
  { name: 'cases', kind: 'value', placeholder: '<dir>', help: '场景目录（缺省 = 包内 cases/）' },
  { name: 'json', kind: 'boolean', help: '以 JSON 输出' },
]

export const IMPORT_OPTIONS: readonly OptionSpec[] = [
  { name: 'dry-run', kind: 'boolean', help: '只转换并打印草稿 YAML，**不登记提案**' },
  { name: 'json', kind: 'boolean', help: '以 JSON 输出' },
]

/* ---------------------------------------------------------------- export -- */

export async function exportCommand(ctx: CliContext, parsed: ParsedOptions): Promise<ExitCode> {
  const format = oneTrimmed(parsed, 'format') ?? 'node-test'
  if (format !== 'node-test' && format !== 'touchstone') {
    return usage(ctx, 'export', `--format 只接受 node-test / touchstone，收到 ${format}`)
  }
  if (!isDirectory(ctx.dirs.casesDir)) {
    return infra(ctx, 'export', `场景目录不存在：${ctx.dirs.casesDir}`)
  }

  const registry = new CaseRegistry(ctx.dirs.casesDir)
  registry.reload()

  if (format === 'touchstone') {
    const runId = oneTrimmed(parsed, 'run-id')
    const located = latestRunJson(ctx.dirs.runsDir, runId)
    if (!located.ok || located.path === undefined) {
      return usage(ctx, 'export', `无法定位运行记录：${located.reason ?? '未知原因'}`)
    }
    // `latestRunJson` 对**显式给的 runId** 只拼路径、不检查存在（它不知道 id 合不合法）。
    // 不在这里补这一刀的话，下一步会以"读文件失败"的形式报成基础设施错误（3）——
    // 而真实原因是"这个 runId 不存在"，属于用法层面（2）。
    if (!existsSync(located.path)) {
      return usage(
        ctx,
        'export',
        `找不到运行记录 ${located.runId ?? runId ?? ''}（期望 ${located.path}）；用 report 看看有哪些`,
      )
    }
    const outDir = oneTrimmed(parsed, 'out') ?? join(ctx.dirs.packageRoot, 'bug_report')
    try {
      const result = await exportBugReports({
        source: located.path,
        outDir,
        scenarioSeverity: (caseId) => registry.all.find((scenario) => scenario.id === caseId)?.severity,
      })
      if (ctx.json) {
        emitJson(ctx.io, {
          command: 'export',
          format,
          ok: true,
          exitCode: EXIT.OK,
          runId: located.runId ?? null,
          outDir: result.outDir,
          exported: result.exported,
          skipped: result.skipped,
        })
        return EXIT.OK
      }
      ctx.io.out(line(`已导出 ${result.exported.length} 条失败场景 → ${result.outDir}`))
      for (const item of result.exported) {
        ctx.io.out(line(`  ${item.caseId}（severity=${item.severity}）→ ${item.dir}`))
      }
      if (result.skipped.length > 0) {
        ctx.io.out(line(''))
        ctx.io.out(line(`未导出 ${result.skipped.length} 条（不是 bug 或无法归因）：`))
        for (const item of result.skipped) ctx.io.out(line(`  ${item.caseId}：${item.reason}`))
      }
      return EXIT.OK
    } catch (error) {
      return infra(ctx, 'export', `导出失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const selected = registry.filter({ status: ['active'] })
  if (selected.length === 0) {
    return usage(ctx, 'export', '没有可导出的 active 场景（draft 场景不导出）')
  }

  const outDir = oneTrimmed(parsed, 'out') ?? ctx.dirs.exportDir
  try {
    const result = await exportScenariosToFile({
      scenarios: selected,
      casesDir: registry.dir,
      fixturesDir: ctx.dirs.fixturesDir,
      outDir,
      libDir: join(ctx.dirs.packageRoot, 'lib'),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    })
    if (ctx.json) {
      emitJson(ctx.io, {
        command: 'export',
        format,
        ok: true,
        exitCode: EXIT.OK,
        count: result.count,
        file: result.file,
      })
      return EXIT.OK
    }
    ctx.io.out(line(`已导出 ${result.count} 条场景 → ${result.file}`))
    ctx.io.out(line(`运行：node --test ${result.file}`))
    return EXIT.OK
  } catch (error) {
    return infra(ctx, 'export', `导出失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/* ---------------------------------------------------------------- import -- */

export async function importCommand(ctx: CliContext, parsed: ParsedOptions): Promise<ExitCode> {
  const file = parsed.positionals[0]
  if (file === undefined || file.trim() === '') {
    return usage(ctx, 'import', '用法：dsh-testkit import <touchstone case.md 路径> [--dry-run]')
  }

  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    return infra(ctx, 'import', `读取失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const draft = parseCaseMd(text)
  if (!draft.validation.ok) {
    const issues = draft.validation.issues.map((issue) => `${issue.path}: ${issue.message}`)
    if (ctx.json) {
      emitJson(ctx.io, { command: 'import', ok: false, exitCode: EXIT.FAILED, file, issues })
    }
    emitError(ctx.io, '转换出的草稿没通过场景校验（**没有**提交提案）：')
    for (const issue of issues) emitError(ctx.io, `  - ${issue}`)
    return EXIT.FAILED
  }

  if (has(parsed, 'dry-run')) {
    if (ctx.json) {
      emitJson(ctx.io, {
        command: 'import',
        dryRun: true,
        ok: true,
        exitCode: EXIT.OK,
        file,
        unmapped: draft.unmapped,
        notes: draft.notes,
        yaml: draft.yaml,
      })
      return EXIT.OK
    }
    ctx.io.out(line(`（--dry-run：只转换、不登记提案）来源：${file}`))
    if (draft.unmapped.length > 0) {
      ctx.io.out(line(`未映射内容（已保留为 YAML 注释）：${draft.unmapped.length} 处`))
    }
    ctx.io.out(draft.yaml.endsWith('\n') ? draft.yaml : `${draft.yaml}\n`)
    return EXIT.OK
  }

  const store = new PipelineStore({ pipelineDir: ctx.dirs.pipelineDir, casesDir: ctx.dirs.casesDir })
  const proposed = store.propose({
    yamlText: draft.yaml,
    notes: draft.notes.length > 0 ? draft.notes.join('；') : '来自 touchstone case.md 的草稿',
  })

  if (!proposed.ok) {
    const findings = (proposed.findings ?? []).map(
      (finding) => `[${finding.level === 'block' ? '阻断' : '提醒'}] ${finding.message}`,
    )
    if (ctx.json) {
      emitJson(ctx.io, {
        command: 'import',
        ok: false,
        exitCode: EXIT.FAILED,
        file,
        error: proposed.error,
        findings,
      })
    }
    emitError(ctx.io, proposed.error)
    for (const finding of findings) emitError(ctx.io, `  ${finding}`)
    return EXIT.FAILED
  }

  if (ctx.json) {
    emitJson(ctx.io, {
      command: 'import',
      ok: true,
      exitCode: EXIT.OK,
      file,
      proposalId: proposed.proposalId,
      batchId: proposed.batchId,
      title: proposed.title,
      kind: proposed.kind,
      status: proposed.status,
      unmapped: draft.unmapped.length,
    })
    return EXIT.OK
  }

  ctx.io.out(line(`已登记提案 ${proposed.proposalId}（批次 ${proposed.batchId}）`))
  ctx.io.out(line(`场景：${proposed.title}（${proposed.kind} / ${proposed.status}）`))
  if (draft.unmapped.length > 0) {
    ctx.io.out(line(`未映射的内容（已保留为 YAML 注释）：${draft.unmapped.length} 处`))
  }
  ctx.io.out(line(''))
  ctx.io.out(line('落地与否由人决定：dsh-testkit 不提供 approve；请用 /testkit issue approve'))
  return EXIT.OK
}

/* ------------------------------------------------------------------ 工具 -- */

function usage(ctx: CliContext, command: string, message: string): ExitCode {
  if (ctx.json) emitJson(ctx.io, { command, ok: false, exitCode: EXIT.USAGE, error: message })
  emitError(ctx.io, message)
  return EXIT.USAGE
}

function infra(ctx: CliContext, command: string, message: string): ExitCode {
  if (ctx.json) emitJson(ctx.io, { command, ok: false, exitCode: EXIT.INFRA, error: message })
  emitError(ctx.io, message)
  return EXIT.INFRA
}
