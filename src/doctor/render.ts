/**
 * 体检报告的渲染（Markdown）。
 *
 * 两条渲染纪律：
 *   · **不撒谎**：探不到的写 `探不到`、没探测的写 `未探测`，绝不渲染成"干净"；
 *   · **可 grep**：小节标题与字段名固定，CI 日志里能用一行 `grep` 找到结论
 *     （例如 `-## 体检发现` / `结论：`）。
 */

import type { DoctorFinding, DoctorReport } from './types.js'

const LEVEL_ICON: Record<DoctorFinding['level'], string> = {
  error: '❌',
  warn: '⚠️',
  info: 'ℹ️',
}

/** 渲染成 Markdown（结尾不带多余空行）。 */
export function renderDoctor(report: DoctorReport): string {
  const lines: string[] = []

  lines.push('# dsh-testkit 宿主体检')
  lines.push('')
  lines.push(
    `- 结论：${report.ok ? '✅ 通过（无 error 级发现）' : '❌ 有问题'} · ` +
      `error ${count(report, 'error')} / warn ${count(report, 'warn')} / info ${count(report, 'info')}`,
  )
  lines.push(`- 生成时间：${report.generatedAt}`)
  lines.push(
    `- 宿主：DSH ${report.host.dshVersion} · Node ${report.host.nodeVersion} · 平台 ${report.host.platform}`,
  )
  lines.push(
    `- 运行时实测：${report.host.runtime.node} · ${report.host.runtime.platform}/${report.host.runtime.arch}`,
  )

  lines.push('')
  lines.push('## 宿主能力')
  lines.push('')
  lines.push(`- 具备：${joinOrNone(report.capabilities.present)}`)
  lines.push(`- driver 依赖的并集：${joinOrNone(report.capabilities.requiredByDrivers)}`)
  lines.push(`- 缺失：${joinOrNone(report.capabilities.missing)}`)

  lines.push('')
  lines.push('## 驱动 × 能力矩阵')
  lines.push('')
  lines.push('| kind | 需要 | 缺失 | 会跳过 | 场景 | active |')
  lines.push('| --- | --- | --- | --- | ---: | ---: |')
  for (const row of report.drivers) {
    lines.push(
      `| ${row.kind} | ${joinOrNone(row.requires)} | ${joinOrNone(row.missing)} | ` +
        `${row.willSkip ? `是（${row.reason ?? ''}）` : '否'} | ${row.scenarios} | ${row.active} |`,
    )
  }

  lines.push('')
  lines.push('## 守卫清单（package.json scripts）')
  lines.push('')
  const verify = report.guards.filter((guard) => guard.group === 'verify')
  const tests = report.guards.filter((guard) => guard.group === 'test')
  lines.push(`- verify:* ${verify.length} 条${verify.length === 0 ? '（缺失）' : ''}`)
  for (const guard of verify) lines.push(`  - \`${guard.name}\` → \`${guard.command}\``)
  lines.push(`- test:* ${tests.length} 条${tests.length === 0 ? '（缺失）' : ''}`)
  for (const guard of tests) lines.push(`  - \`${guard.name}\` → \`${guard.command}\``)

  lines.push('')
  lines.push('## 场景集')
  lines.push('')
  lines.push(
    `- ${report.cases.scenarios} 条 / ${report.cases.kinds} 个 kind · active ${report.cases.active} · ` +
      `draft ${report.cases.draft} · retired ${report.cases.retired} · blocked ${report.cases.blocked}`,
  )
  lines.push(`- 校验失败 ${report.cases.invalid} 条 · 索引不一致 ${report.cases.indexIssues} 项`)
  lines.push(`- 目录：${report.cases.dir}`)

  lines.push('')
  lines.push('## 残留探测')
  lines.push('')
  if (report.residue.targets.length === 0) {
    lines.push('- 未探测（注意：**未探测 ≠ 干净**）')
  } else {
    lines.push(`- 探测目标：${report.residue.targets.join('；')}`)
    const known = report.residue.record.leftovers.filter((item) => !item.startsWith('unknown:'))
    const unknown = report.residue.record.leftovers.filter((item) => item.startsWith('unknown:'))
    lines.push(`- 残留：${known.length} 项${known.length === 0 ? '' : ` → ${known.slice(0, 10).join('、')}`}`)
    lines.push(
      `- 探不到：${unknown.length} 项${unknown.length === 0 ? '' : ` → ${unknown.slice(0, 5).join('、')}`}`,
    )
    if (report.residue.record.released.length > 0) {
      lines.push(`- 已释放：${report.residue.record.released.join('、')}`)
    }
  }
  for (const note of report.residue.notes) lines.push(`- 说明：${note}`)

  lines.push('')
  lines.push('## 最近一次运行')
  lines.push('')
  if (!report.runs.exists) {
    lines.push(`- 报告目录不存在：${report.runs.dir}`)
  } else if (report.runs.latest === undefined) {
    lines.push(`- 报告目录里没有可读的 run.json（共扫描 ${report.runs.runCount} 次运行）`)
  } else {
    const { latest } = report.runs
    lines.push(`- runId：${latest.runId}${latest.startedAt === undefined ? '' : `（${latest.startedAt}）`}`)
    lines.push(
      `- totals：total ${latest.totals.total} · passed ${latest.totals.passed} · ` +
        `failed ${latest.totals.failed} · skipped ${latest.totals.skipped} · errored ${latest.totals.errored}`,
    )
    lines.push(`- 历史运行 ${report.runs.runCount} 次 · 目录：${report.runs.dir}`)
  }
  for (const note of report.runs.notes) lines.push(`- 说明：${note}`)

  lines.push('')
  lines.push(`## 覆盖缺口（前 ${report.coverage.gaps.length} / 共 ${report.coverage.gapCount}）`)
  lines.push('')
  if (report.coverage.gaps.length === 0) {
    lines.push('- 没有缺口。')
  } else {
    for (const gap of report.coverage.gaps) {
      lines.push(
        `- [${gap.severity}] ${gap.scope} · ${gap.code}：${gap.message}` +
          `（怎么补：${gap.action}）`,
      )
    }
  }
  lines.push(
    `- 覆盖汇总：场景 ${report.coverage.totals.scenarios} · kind ${report.coverage.kinds} · ` +
      `active ${report.coverage.totals.active} · 带 owner ${report.coverage.totals.withOwner} · ` +
      `带 tag ${report.coverage.totals.tagged}`,
  )

  lines.push('')
  lines.push('## 体检发现')
  lines.push('')
  if (report.findings.length === 0) {
    lines.push('- 没有发现。')
  } else {
    for (const finding of report.findings) {
      lines.push(`- ${LEVEL_ICON[finding.level]} [${finding.code}] ${finding.message}`)
      if (finding.hint !== undefined) lines.push(`  - 建议：${finding.hint}`)
    }
  }

  return lines.join('\n')
}

function count(report: DoctorReport, level: DoctorFinding['level']): number {
  return report.findings.filter((finding) => finding.level === level).length
}

function joinOrNone(values: readonly string[]): string {
  return values.length === 0 ? '—' : values.join('、')
}
