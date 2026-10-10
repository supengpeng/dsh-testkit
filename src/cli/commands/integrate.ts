/**
 * CLI 的两条"协作与体检"命令：`triage` 与 `doctor`。
 *
 * 为什么单开一个文件（而不是塞进 `insight.ts`）：这两条命令的**数据来源不同**——
 * insight 读历史 `run.json` 做聚合，triage 生成"给外部系统看的文本"，
 * doctor 则要**真的建一个宿主**去探测能力与残留。混在一起会让"谁依赖 DSH"
 * 这件事在文件里看不出来。
 *
 * 纪律（与 `src/triage` 一致）：**只生成文本，不发任何请求**。
 * 真正建 issue / 贴评论是 CI 的活（见 `.github/workflows` 与 `action.yml`）。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { CaseRegistry } from '../../cases/registry.js'
import { collectHostResidue, renderDoctor, runDoctor } from '../../doctor/index.js'
import { createHeadlessHost } from '../../headless/index.js'
import { createDriverRegistry } from '../../kinds/index.js'
import type { RunSummary } from '../../runtime/runlog.js'
import { latestRunJson } from '../../surface/runs.js'
import { buildIssueDraft, buildPrComment } from '../../triage/index.js'
import { has, oneTrimmed, type OptionSpec, type ParsedOptions } from '../args.js'
import type { CliContext } from '../context.js'
import { EXIT, type ExitCode } from '../exit.js'
import { emitError, emitJson, line } from '../io.js'

/* ------------------------------------------------------------------ triage -- */

export const TRIAGE_OPTIONS: readonly OptionSpec[] = [
  {
    name: 'format',
    kind: 'value',
    placeholder: 'pr|issue',
    help: '输出形态：pr（PR 评论，默认）| issue（issue 草稿）；都不发请求',
  },
]

/** 读一份 `run.json`（形状体检失败给出人话，而不是抛栈）。 */
function readSummary(ctx: CliContext, runId: string | undefined): { summary?: RunSummary; error?: string } {
  const located = latestRunJson(ctx.dirs.runsDir, runId)
  if (!located.ok || located.path === undefined) {
    return { error: `无法定位运行记录：${located.reason ?? '未知原因'}` }
  }
  try {
    return { summary: JSON.parse(readFileSync(located.path, 'utf8')) as RunSummary }
  } catch (error) {
    return { error: `读取 ${located.path} 失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function triageCommand(ctx: CliContext, parsed: ParsedOptions): Promise<ExitCode> {
  const runId = parsed.positionals[0]
  const read = readSummary(ctx, runId)
  if (read.summary === undefined) {
    emitError(ctx.io, read.error ?? '读取运行记录失败')
    return EXIT.USAGE
  }
  const summary = read.summary

  const format = (oneTrimmed(parsed, 'format') ?? 'pr').toLowerCase()
  if (format === 'pr') {
    const comment = buildPrComment(summary)
    if (ctx.json) {
      emitJson(ctx.io, { command: 'triage', ok: true, exitCode: EXIT.OK, format, runId: summary.runId, comment })
    } else {
      ctx.io.out(line(comment))
    }
    return EXIT.OK
  }

  if (format === 'issue') {
    const draft = buildIssueDraft(summary)
    // 没有失败项时返回的是**空哨兵**（见 src/triage/issue.ts）：这不是错误，
    // 而是"没有可开的 issue"。CI 必须先判 title 再决定建不建。
    if (draft.title === '') {
      if (ctx.json) {
        emitJson(ctx.io, { command: 'triage', ok: true, exitCode: EXIT.OK, format, runId: summary.runId, draft: null })
      } else {
        ctx.io.out(line('没有 failed / errored 的用例：无需开 issue。'))
      }
      return EXIT.OK
    }
    if (ctx.json) {
      emitJson(ctx.io, { command: 'triage', ok: true, exitCode: EXIT.OK, format, runId: summary.runId, draft })
      return EXIT.OK
    }
    ctx.io.out(line(`标题：${draft.title}`))
    ctx.io.out(line(`标签：${draft.labels.length > 0 ? draft.labels.join(', ') : '（无）'}`))
    ctx.io.out(
      line(
        `指派：${draft.assignees.length > 0 ? draft.assignees.join(', ') : '（无 owner——靠覆盖矩阵的 no-owner 缺口补齐）'}`,
      ),
    )
    ctx.io.out(line(''))
    ctx.io.out(line(draft.body))
    return EXIT.OK
  }

  emitError(ctx.io, `不支持的 --format：${format}（pr | issue）`)
  return EXIT.USAGE
}

/* ------------------------------------------------------------------ doctor -- */

export const DOCTOR_OPTIONS: readonly OptionSpec[] = [
  { name: 'no-residue', kind: 'boolean', help: '跳过残留探测（默认会查临时目录 / 端口 / 进程）' },
]

/** 从包根读 `package.json` 的 scripts（doctor 的守卫清单来源）。读不到时返回空表并如实说明。 */
function readPackageScripts(packageRoot: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    return pkg.scripts ?? {}
  } catch {
    return {}
  }
}

export async function doctorCommand(ctx: CliContext, parsed: ParsedOptions): Promise<ExitCode> {
  const registry = new CaseRegistry(ctx.dirs.casesDir)
  registry.reload()

  const host = await createHeadlessHost()
  try {
    const residue = has(parsed, 'no-residue') ? undefined : await collectHostResidue()
    const report = await runDoctor({
      registry,
      host: {
        capabilities: host.host.capabilities,
        env: {
          dshVersion: host.host.env.dshVersion,
          platform: host.host.env.platform,
          nodeVersion: host.host.env.nodeVersion,
        },
      },
      scripts: readPackageScripts(ctx.dirs.packageRoot),
      runsDir: ctx.dirs.runsDir,
      casesDir: registry.dir,
      drivers: createDriverRegistry(),
      ...(residue === undefined ? {} : { residue }),
    })

    if (ctx.json) {
      emitJson(ctx.io, { command: 'doctor', ok: true, exitCode: EXIT.OK, report })
    } else {
      ctx.io.out(line(renderDoctor(report)))
    }
    return EXIT.OK
  } finally {
    await host.dispose()
  }
}
