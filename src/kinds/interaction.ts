/**
 * kind: interaction —— 模拟人的回答与审批决策。
 *
 * ## 两个 waterfall 的形状（**注意与 `llm/stream` 不同**）
 *
 * ```
 * 'user-questions/request'(this: Scoped<Agent>, request: AskUserQuestionRequestEvent,
 *                          next: () => Promise<AskUserQuestionAnswer>): Promise<AskUserQuestionAnswer>
 * 'approval/request'(this: Scoped<Agent>, req: ApprovalRequestEvent,
 *                    next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>
 * ```
 *
 * ⚠️ 这两个的 `next` 是 **`() => Promise<...>`**，而 `llm/stream` 的 `next` 是
 * **同步**返回 `AsyncIterable`。本项目里两种形状都存在——照抄隔壁 driver 会得到
 * 一个 `undefined` 或一个未 await 的 Promise，且都是静默失效。
 *
 * ## 为什么 act 直接触发 waterfall，而不是调服务方法
 *
 * `approval.request()` 有前置条件：**必须有开启的 turn**（审计对要被会话日志的
 * commit/replay 边界包住），否则在追加任何东西之前就拒绝。自检场景没有 turn，
 * 直接调必然抛错。
 *
 * 所以 act 走 `host.waterfall(...)` 「替宿主发起这次请求」——绕过 turn 前置条件，
 * 但仍然经过完整的 listener 链。这也是真实 DSH 内部触发这两个事件的形式。
 *
 * ## 取值词汇
 *
 * `ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`
 * （`allowed-once` 是唯一的授予）。本 driver 只产出前两个为代表，
 * 另外两个留给"答者缺席/被取消"的真实路径。
 */

import type { Scenario, StepAction } from '../cases/types.js'
import { SkipCase, type Driver, type DriverContext } from './types.js'

/** DSH 的审批结果词汇。 */
export const APPROVAL_OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable'] as const
export type ApprovalOutcomeLike = (typeof APPROVAL_OUTCOMES)[number]

export interface InteractionQuestionSpec {
  /** 简写：所有问题都选这一个（放进 `selected`）。 */
  answer?: string
  /** 显式选中项（每个问题都用这个数组）。 */
  select?: string[]
  /** 完全显式：直接给出 answers 数组。 */
  answers?: Array<{ id: string; selected: string[]; custom?: string }>
  /** 自定义回答（进 `custom` 字段）。 */
  custom?: string
  /** 故意不答：抛 `TESTKIT_QUESTION_TIMEOUT`，用于测超时路径。 */
  timeout?: boolean
}

export interface InteractionApprovalSpec {
  /** 决策结果；缺省 `rejected`。 */
  decision?: ApprovalOutcomeLike
  /** 该决策「对应的理由」，仅记账用（真实理由由 DSH 从请求里读）。 */
  reason?: string
}

export interface InteractionSetup {
  question?: InteractionQuestionSpec
  approval?: InteractionApprovalSpec
}

interface QuestionRequestLike {
  questions?: Array<{ id?: string }>
}

/** 把声明变成 DSH 要的 `AskUserQuestionAnswer`。纯函数，可单测。 */
export function buildAnswer(
  request: QuestionRequestLike | undefined,
  spec: InteractionQuestionSpec,
): { answers: Array<{ id: string; selected: string[]; custom?: string }> } {
  if (Array.isArray(spec.answers)) return { answers: spec.answers }

  const questions = Array.isArray(request?.questions) ? request.questions : []
  const selected = Array.isArray(spec.select)
    ? spec.select
    : spec.answer === undefined
      ? []
      : [spec.answer]

  return {
    answers: questions.map((q, index) => ({
      id: typeof q?.id === 'string' && q.id !== '' ? q.id : `q${index + 1}`,
      selected,
      ...(spec.custom === undefined ? {} : { custom: spec.custom }),
    })),
  }
}

/** 校验审批决策词汇，非法值给出可读错误而不是让 DSH 归一化成 unavailable。 */
export function normalizeDecision(spec: InteractionApprovalSpec): ApprovalOutcomeLike {
  const decision = spec.decision ?? 'rejected'
  if (!(APPROVAL_OUTCOMES as readonly string[]).includes(decision)) {
    throw new Error(
      `interaction.approval.decision 不合法：「${String(decision)}」。` +
        `必须是：${APPROVAL_OUTCOMES.join(' | ')}`,
    )
  }
  return decision
}

/** 本 driver 在"故意不答"时抛出的标记错误。 */
export const TESTKIT_QUESTION_TIMEOUT = 'TESTKIT_QUESTION_TIMEOUT'

export const interactionDriver: Driver = {
  kind: 'interaction',
  description: '模拟人的回答与审批决策（接管 user-questions/request 与 approval/request）',
  // 故意**不**静态声明 requires：
  // question 分支需要 userQuestions、approval 分支不需要，
  // 静态声明会让 approval-only 场景被误判成"缺能力"而跳过。
  // 实际检查放在 setup 里（按用到的分支），act 中再防御一次。

  async setup(ctx: DriverContext, scenario: Scenario): Promise<void> {
    const setup = (scenario.setup as { interaction?: InteractionSetup }).interaction
    if (!setup) return

    if (setup.question) {
      if (!ctx.host.capabilities.has('userQuestions')) {
        throw new SkipCase('宿主不具备 userQuestions 能力，question 分支无法执行')
      }
      const spec = setup.question
      let count = 0

      const dispose = ctx.host.on(
        'user-questions/request',
        async (request: QuestionRequestLike) => {
          count += 1
          ctx.fixture.note('questionCount', count)
          ctx.fixture.noteAppend('questions', {
            index: count,
            questionCount: Array.isArray(request?.questions) ? request.questions.length : 0,
          })

          if (spec.timeout) {
            const error = new Error(TESTKIT_QUESTION_TIMEOUT)
            ;(error as Error & { code?: string }).code = 'ASK_TIMED_OUT'
            throw error
          }
          return buildAnswer(request, spec)
        },
      )
      ctx.fixture.add('interaction:question', dispose)
    }

    if (setup.approval) {
      const decision = normalizeDecision(setup.approval)
      let count = 0

      const dispose = ctx.host.on('approval/request', async (req: { toolName?: string }) => {
        count += 1
        ctx.fixture.note('approvalCount', count)
        ctx.fixture.noteAppend('approvals', {
          index: count,
          toolName: typeof req?.toolName === 'string' ? req.toolName : undefined,
        })
        return decision
      })
      ctx.fixture.add('interaction:approval', dispose)
      ctx.fixture.note('plannedDecision', decision)
    }
  },

  async act(ctx: DriverContext, action: StepAction): Promise<void> {
    if (!('interaction' in action)) {
      throw new Error(
        `interaction driver 只支持 \`interaction\` 动作，收到：${Object.keys(action as object).join('/')}`,
      )
    }

    const spec = action.interaction

    if ('question' in spec) {
      if (!ctx.host.capabilities.has('userQuestions')) {
        throw new SkipCase('宿主不具备 userQuestions 能力')
      }
      const request = {
        questions: [
          {
            id: 'testkit-q1',
            question: spec.question.question,
            ...(spec.question.header === undefined ? {} : { header: spec.question.header }),
            ...(spec.question.detail === undefined ? {} : { detail: spec.question.detail }),
            ...(spec.question.options === undefined ? {} : { options: spec.question.options }),
            ...(spec.question.multiSelect === undefined
              ? {}
              : { multiSelect: spec.question.multiSelect }),
          },
        ],
      }

      let answer: unknown
      let error: string | undefined
      try {
        answer =
          await // next 的兜底 = 没有其他答者时的真实位置。
          // DSH 的语义是「答者缺席 → fail closed 成 unavailable」，
          // 这里用一个明确的错误更便于自检时区分"没人答"与"答错了"。
          Promise.resolve(
            ctx.host.waterfall('user-questions/request', [request], () => {
              throw new Error('TESTKIT_NO_ANSWERER')
            }),
          )
      } catch (caught) {
        error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)
      }

      ctx.fixture.note('questionRequest', request)
      ctx.fixture.note('answer', answer)
      ctx.fixture.note('questionError', error)
      return
    }

    if ('approval' in spec) {
      const request = {
        agent: { id: 'testkit-agent' },
        toolName: spec.approval.toolName,
        ...(spec.approval.callId === undefined ? {} : { callId: spec.approval.callId }),
        ...(spec.approval.reason === undefined ? {} : { reason: spec.approval.reason }),
        signal: ctx.signal,
      }

      let outcome: unknown
      let error: string | undefined
      try {
        // 兜底返回 'unavailable'：与 DSH「答者缺席 fail closed」的语义一致
        outcome = await Promise.resolve(
          ctx.host.waterfall('approval/request', [request], () => 'unavailable'),
        )
      } catch (caught) {
        error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)
      }

      ctx.fixture.note('approvalRequest', request)
      ctx.fixture.note('approvalOutcome', outcome)
      ctx.fixture.note('approvalError', error)
      return
    }

    throw new Error('interaction 动作必须包含 question 或 approval')
  },
}
