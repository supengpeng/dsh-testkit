/**
 * 错误消息质量：把一次失败**证据**翻译成"可能的原因 + 下一步"。
 *
 * ## 它和 `classify.ts` 的分工（别搞混）
 *
 * · `classifyCase`（`src/analysis/classify.ts`）给的是**归因类别**：
 *   `product_bug` / `case_bug` / `driver_bug` / `env` / `flaky`——回答"这该谁来看"。
 * · 本模块给的是**可能原因**：在类别之上再走一步，回答"大概因为什么、先去做什么"。
 *
 * 类别是**分流建议**，原因是**排查假设**。两者都不是判决：报告里必须仍然并列
 * 展示原始证据（期望 / 实际 / error / 最小复现）。
 *
 * ## 纪律：不编（宁可不猜）
 *
 * 只有**有据可依**才给原因：每条原因都必须能指回 outcome 上的具体证据
 * （error 文本、某一步的 action.detail、某条失败断言的 ref/实际值、rounds、
 * releaseFailures、usage）。指不回去的，一律不写。
 *
 * 因此：
 * · `passed` → 空数组（通过没有"原因"）；
 * · `skipped` → 空数组（`skipReason` 已经把话说完了，再说一遍是噪声）；
 * · 失败但没有任何本模块认得的证据 → 空数组（例如"failed 且一条失败断言都没有、
 *   也没有 action 失败"的引擎侧异常）。强行给一堆"可能原因"只会淹没真正的线索。
 *
 * ## 可能性（likelihood）的标定
 *
 * · `high`   —— 证据直接就是原因本身（超时消息 / 预算超限 / 动作没跑通 / 多轮不一致 /
 *               断言引用的路径不存在）；
 * · `medium` —— 证据是事实，但从事实到原因还需要一步判断。典型：`product_bug`
 *               的"期望 ≠ 实际"——"被测对象语义变了"和"断言写错了但取到了值"
 *               在运行期**不可区分**（见 `classify.ts` 的边界说明），所以不能标 high；
 * · `low`    —— 至少两个方向都说得通，只能作为**排查起点**（例：实际值是 `undefined`：
 *               既可能是取证没产出，也可能是被测对象没写）。
 */

import type { Assertion } from '../cases/types.js'
import type { AssertionOutcome, CaseOutcome } from '../runtime/runlog.js'

/** 一条可能原因。四列缺一不可：没有依据 / 没有下一步的"原因"都是噪声。 */
export interface ProbableCause {
  /** 从 1 开始的序号（按 `likelihood` 从高到低）。 */
  rank: number
  likelihood: 'high' | 'medium' | 'low'
  /** 可能的原因（一句话，说清"是什么导致了这条失败"）。 */
  cause: string
  /** 依据：必须指回 outcome 上的具体证据，不许写"可能是环境问题"这种空话。 */
  evidence: string
  /** 下一步：读者可以立刻执行的动作。 */
  nextStep: string
}

/** 可能性的中文标签（报告与工具输出共用，避免两处漂移）。 */
export const LIKELIHOOD_LABEL: Record<ProbableCause['likelihood'], string> = {
  high: '高',
  medium: '中',
  low: '低',
}

/**
 * 最多给几条。
 *
 * 为什么封顶：错误消息的价值来自"读完就知道去哪儿"。给五条并列的猜测，
 * 读者反而要自己排序——那就退化成噪声了。宁可少给，也要把最强的那条排在前面。
 */
const MAX_CAUSES = 3

/** 证据字段的截断长度（报告里一条原因不该占满一屏）。 */
const MAX_FIELD = 200

/**
 * 环境特征（与 `classify.ts` 的 `ENV_PATTERNS` 同源）。
 *
 * `classify.ts` 不导出它的正则表（那是它的内部实现，且已冻结），
 * 这里只取本模块**要用到的最小集合**：预算 / 超时 / 宿主条件。
 */
const BUDGET_PATTERN = /预算超限|BudgetExceeded/
const TIMEOUT_PATTERN = /超时/
const HOST_PATTERN = /宿主缺少能力|沙箱/
const NO_DRIVER_PATTERN =
  /driver 尚未实现|driver 未实现|没有对应 driver|无法判断动作属于哪个 kind|setup 里出现了 kind/

/** 断言引用的**取值失败**特征（同 `classify.ts` 的 `REF_PATTERNS`）。 */
const REF_PATTERNS: readonly RegExp[] = [/取值失败/, /未知 ref 前缀/, /ref 缺少前缀/]

/** 合法的 ref 前缀（真源在 `src/runtime/refs.ts`）。 */
const REF_PREFIXES = new Set(['fx', 'case', 'env'])

/** 判定词（与 schema 的 `ASSERTION_WORDS` 对应；只用于把期望值写进依据）。 */
const ASSERTION_WORDS = [
  'is',
  'isNot',
  'notIs',
  'exists',
  'notExists',
  'contains',
  'notContains',
  'matches',
  'atLeast',
  'atMost',
  'length',
  'lengthAtLeast',
  'lengthAtMost',
  'throws',
] as const

interface Candidate {
  likelihood: ProbableCause['likelihood']
  cause: string
  evidence: string
  nextStep: string
}

/**
 * 推断一条失败 case 的可能原因（按可能性从高到低、最多 3 条）。
 *
 * 纯函数：只读 outcome，不做任何 I/O、不调模型、不猜运行环境。
 */
export function probableCauses(outcome: CaseOutcome): ProbableCause[] {
  // 通过：没有"原因"可谈。
  if (outcome.verdict === 'passed') return []
  // 跳过：原因已经由 skipReason 说清（成本闸门 / 宿主能力 / 夹具），重复只是噪声。
  if (outcome.verdict === 'skipped') return []

  const text = evidenceText(outcome)
  const failing = failingAssertions(outcome)
  const candidates: Candidate[] = []

  // ① 预算超限：不是"结论上错了"，而是"这次运行的条件不足"。
  if (BUDGET_PATTERN.test(text)) {
    const usage =
      outcome.usage === undefined
        ? ''
        : `；用量：模型调用 ${outcome.usage.modelCalls} 次 / token ${outcome.usage.tokens}`
    candidates.push({
      likelihood: 'high',
      cause: '这条场景被「本次运行的预算上限」截断了：它不是在结论上失败，而是没跑完。',
      evidence: `错误：${clip(text)}${usage}`,
      nextStep:
        '提高场景的 budget.maxModelCalls / maxTokens（或本次运行的上限）后再跑同一条；' +
        '在拿到完整结论之前，不要据此改动断言或判定被测对象有问题。',
    })
  }

  // ② 抖动：多轮结果不一致。证据是 rounds，不靠猜。
  const rounds = outcome.rounds
  if (rounds !== undefined && rounds.length > 1 && rounds.some(Boolean) && rounds.some((ok) => !ok)) {
    candidates.push({
      likelihood: 'high',
      cause:
        '同一条场景多轮结果不一致（抖动），而不是稳定地失败：先怀疑时序 / 共享状态 / 夹具隔离，' +
        '而不是被测对象的语义。',
      evidence: `各轮结果：${rounds.map((ok) => (ok ? '通过' : '失败')).join(' / ')}（共 ${rounds.length} 轮）`,
      nextStep:
        '同一条命令连跑 5~10 次（或把 runtime.repeat 调大）看频率；再核对夹具是否每轮重建、' +
        '场景是否正确声明了 parallel。',
    })
  }

  // ③ 超时：阈值偏紧 / 宿主慢 / 被测对象真的卡住，三者要用重跑区分。
  if (TIMEOUT_PATTERN.test(outcome.error ?? '')) {
    candidates.push({
      likelihood: 'high',
      cause: '撞上了本次运行的时间上限：可能是阈值偏紧、宿主较慢，也可能是被测对象卡住。',
      evidence: `错误：${clip(outcome.error ?? '')}；本 case 耗时 ${outcome.durationMs}ms`,
      nextStep:
        '先单独重跑一次（/testkit run <id>）看是否稳定复现；稳定复现再提高 runtime.timeoutMs ' +
        '或换空闲机器区分"慢"与"卡"。',
    })
  }

  // ④ 装配层：这个 kind 在当前注册表里没有 driver。
  if (NO_DRIVER_PATTERN.test(text)) {
    candidates.push({
      likelihood: 'high',
      cause: '这个动作在本次装配里没有对应的 driver：问题在场景/装配，不在被测对象。',
      evidence: `错误：${clip(text)}`,
      nextStep:
        '检查 kind 拼写与 driver 注册表（`createDriverRegistry()`）；`testkit_list` 能确认该 kind ' +
        '是否真的有场景在跑。',
    })
  }

  // ⑤ 动作本身没跑通 → driver 与被测宿主的契约不符。
  const broken = outcome.steps.find((step) => step.action !== undefined && !step.action.ok)
  if (broken?.action !== undefined) {
    candidates.push({
      likelihood: 'high',
      cause: '失败发生在动作执行阶段（不是断言阶段）：driver 与宿主提供的服务契约/形状对不上（前置条件不满足）。',
      evidence: `第「${broken.name}」步动作 ${broken.action.kind} 未成功${
        broken.action.detail === undefined ? '' : `：${clip(broken.action.detail)}`
      }`,
      nextStep:
        '对照 docs/ARCHITECTURE.md 的适配边界，确认宿主真的提供了该服务与所需方法；' +
        '在活宿主上重跑一次，区分"driver 写错"与"宿主没接上"。',
    })
  }

  // ⑥ 夹具释放失败：有资源泄漏风险，且会污染后续场景。
  if (outcome.releaseFailures.length > 0) {
    const first = outcome.releaseFailures[0]
    candidates.push({
      likelihood: 'high',
      cause: '夹具释放失败：有资源泄漏风险，后续场景可能因此被污染（结论不可信）。',
      evidence: `${outcome.releaseFailures.length} 项释放失败；首个：${
        first === undefined ? '（无明细）' : `${first.label} → ${clip(first.error)}`
      }`,
      nextStep:
        '检查该 driver 的 setup 是否每次都经 fx.add() 登记、teardown 是否成对；' +
        '修好后重跑整批（而不是只重跑这一条）确认没有连锁影响。',
    })
  }

  // ⑦ 宿主条件不满足（能力缺失 / 沙箱拒绝）。
  if (HOST_PATTERN.test(text)) {
    candidates.push({
      likelihood: 'high',
      cause: '运行条件不满足（宿主缺少能力或沙箱拒绝）：这是"这台机器跑不了"，不是被测对象的结论。',
      evidence: `依据文本：${clip(text)}`,
      nextStep:
        '换具备该能力的宿主，或按需调整沙箱配置（sandbox.allowShell / allowFileWrite / allowedPaths）后重跑。',
    })
  }

  // ⑧ 用例侧：断言引用的取证路径不存在（结构性信号，classify 也据此判 case_bug）。
  const refBroken = failing.filter(
    (item) => REF_PATTERNS.some((re) => re.test(item.message)) || !hasKnownRefPrefix(item),
  )
  const firstRefBroken = refBroken[0]
  if (outcome.failureCategory === 'case_bug' || firstRefBroken !== undefined) {
    const evidence =
      firstRefBroken === undefined
        ? // 理论上走不到：classify 判 case_bug 的前提就是"失败断言全部取值失败"。
          // 真出现了（例如手工构造的 outcome）也要如实说清，而不是编一条明细。
          `归因标记为 case_bug，但失败断言里没有取值失败明细：${clip(outcome.error ?? '（无错误文本）')}`
        : `${refBroken.length} 条失败断言的 ref 取不到值（取值失败或前缀非法）；首个：${firstRefBroken.assertion.ref} → ${clip(
            firstRefBroken.message,
          )}`
    candidates.push({
      likelihood: 'high',
      cause: '失败断言引用的取证路径取不到值：多半是用例写错了 ref，而不是被测对象不对。',
      evidence,
      nextStep:
        '在 run.json 的 notes / 该 driver 的取证键里核对 ref（前缀只能是 fx / case / env）；' +
        '改的是断言，不是被测对象。',
    })
  }

  // ⑨ 产品语义：断言取到了值，但期望与实际不符。
  const semantic = failing.filter((item) => item.actual !== undefined)
  if (outcome.failureCategory === 'product_bug' && semantic.length > 0) {
    const first = semantic[0]!
    candidates.push({
      likelihood: 'medium',
      cause: '被测对象的行为与期望不一致（语义变化或回归）。注意：「断言写错了但能取到值」长得一模一样，需人看一眼。',
      evidence: `${semantic.length} 条失败断言取到了实际值；首个：${first.assertion.ref} 期望 ${describeExpectation(
        first.assertion,
      )}，实际 ${clip(stringify(first.actual))}`,
      nextStep: outcome.minimalRepro
        ? '按报告里的最小复现单跑确认；若确认是有意的行为变化，改场景期望并在 PR 里写明理由。'
        : '先单跑这一条确认可复现，再对照被测对象的变更（版本 / diff）判断是回归还是预期变化。',
    })
  } else if (outcome.failureCategory === 'product_bug' && failing.length > 0) {
    // ⑩ 实际值是 undefined：两个方向都说得通，只能当排查起点。
    const first = failing[0]!
    candidates.push({
      likelihood: 'low',
      cause: '断言失败但「实际值」是 undefined：既可能是取证没产出（键名/时机），也可能是被测对象确实没写。',
      evidence: `首个失败断言：${first.assertion.ref} → ${clip(first.message)}`,
      nextStep:
        '先看该步骤的取证增量（run.json 的 steps[].notes）里有没有这个键；' +
        '键都不存在就改用例，键在但值为空才去查被测对象。',
    })
  }

  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => {
      const byLikelihood = LIKELIHOOD_WEIGHT[a.candidate.likelihood] - LIKELIHOOD_WEIGHT[b.candidate.likelihood]
      // 同可能性时保持规则顺序（规则顺序本身就是依据的强弱顺序），排序必须稳定
      return byLikelihood !== 0 ? byLikelihood : a.index - b.index
    })
    .slice(0, MAX_CAUSES)
    .map(({ candidate }, index) => ({
      rank: index + 1,
      likelihood: candidate.likelihood,
      cause: candidate.cause,
      evidence: candidate.evidence,
      nextStep: candidate.nextStep,
    }))
}

const LIKELIHOOD_WEIGHT: Record<ProbableCause['likelihood'], number> = {
  high: 0,
  medium: 1,
  low: 2,
}

/**
 * 渲染成固定格式的文本（报告、工具输出、CLI 共用）。
 *
 * 空数组不是错误：那是"证据不足，不做推断"的如实表达。
 */
export function renderCauses(causes: readonly ProbableCause[]): string {
  if (causes.length === 0) {
    return '可能原因：无（证据不足，不做推断——宁可不猜，也不拿猜测当噪声）'
  }

  const lines: string[] = ['可能原因（按可能性排序）：']
  for (const item of causes) {
    lines.push(`${item.rank}. 原因：${item.cause}`)
    lines.push(`   可能性：${LIKELIHOOD_LABEL[item.likelihood]}`)
    lines.push(`   依据：${item.evidence}`)
    lines.push(`   下一步：${item.nextStep}`)
  }
  return lines.join('\n')
}

/* --------------------------------------------------------------- 内部 -- */

/** 失败断言（软断言不算：它们不影响判定，见 runner 的 hasHardFailure）。 */
function failingAssertions(outcome: CaseOutcome): AssertionOutcome[] {
  return outcome.steps.flatMap((step) => step.assertions.filter((item) => !item.ok && !item.soft))
}

/** 把可用的错误文本拼起来（错误 + 失败动作的 detail + 释放失败）。 */
function evidenceText(outcome: CaseOutcome): string {
  const parts: string[] = []
  if (outcome.error !== undefined && outcome.error !== '') parts.push(outcome.error)
  for (const step of outcome.steps) {
    if (step.action !== undefined && !step.action.ok && step.action.detail !== undefined) {
      parts.push(step.action.detail)
    }
  }
  for (const failure of outcome.releaseFailures) parts.push(failure.error)
  return parts.join('\n')
}

/** ref 前缀是否合法（不合法 = 结构性用例缺陷，refs.ts 会报「未知 ref 前缀」）。 */
function hasKnownRefPrefix(item: AssertionOutcome): boolean {
  const ref = item.assertion.ref
  if (typeof ref !== 'string') return false
  const dot = ref.indexOf('.')
  if (dot <= 0) return false
  return REF_PREFIXES.has(ref.slice(0, dot))
}

/** 断言里写了哪个判定词与期望值（用于把"期望"写进依据）。 */
function describeExpectation(assertion: Assertion): string {
  // 断言词是动态键（`is` / `contains` / …），类型层没有索引签名，这里显式擦除一次
  const bag = assertion as unknown as Record<string, unknown>
  for (const word of ASSERTION_WORDS) {
    if (bag[word] !== undefined) {
      return `${word} ${stringify(bag[word])}`
    }
  }
  return '（该断言没有判定词）'
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}

/** 压平 + 截断：证据进报告前必须能一眼读完。 */
function clip(text: string, max = MAX_FIELD): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}
