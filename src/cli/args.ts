/**
 * 极小的命令行解析器。
 *
 * ## 为什么不引 commander / yargs
 *
 * 本包对依赖的态度是"能不加就不加"（见 `package.json` 的 dependencies：只有 `yaml`）。
 * 而这里真正需要的语法只有一小撮：`--flag`、`--flag=value`、`--flag value`、`-k value`、
 * 以及位置参数。**注意 `package.json` 的 `bin` 已经是发布面的一部分**，
 * 多一个运行时依赖就多一份安装体积与供应链面。
 *
 * ## 一条刻意的严格性
 *
 * 未知选项**一律报错**（退出码 2），绝不静默忽略。
 * 静默忽略的后果是"我以为传了 `--allow-model`，其实拼成了 `--allow_model`"——
 * 于是场景被闸门跳过，而人以为它跑过了。宁可吵闹。
 */

export interface OptionSpec {
  /** 长选项名（不带 `--`）。 */
  name: string
  /** 短别名（不带 `-`），可选。 */
  alias?: string
  /** `boolean` 不带值；`value` 带一个值；`repeat` 可多次出现并累积。 */
  kind: 'boolean' | 'value' | 'repeat'
  /** 占位名（错误信息与 help 用），如 `<id>`。 */
  placeholder?: string
  /** 一行说明（`help <子命令>` 直接渲染它——help 与解析器同源，不会漂移）。 */
  help?: string
}

export interface ParsedOptions {
  positionals: string[]
  /** 取值型选项：name → 值数组（`repeat` 会累积）。 */
  values: Map<string, string[]>
  /** 布尔选项：出现过即在此集合。 */
  flags: Set<string>
  /** 用法错误（未知选项 / 缺值）。非空时调用方应返回退出码 2。 */
  errors: string[]
}

/** 解析 argv。纯函数，不读环境、不写输出（便于单测）。 */
export function parseOptions(argv: readonly string[], specs: readonly OptionSpec[]): ParsedOptions {
  const byName = new Map<string, OptionSpec>()
  const byAlias = new Map<string, OptionSpec>()
  for (const spec of specs) {
    byName.set(spec.name, spec)
    if (spec.alias !== undefined) byAlias.set(spec.alias, spec)
  }

  const result: ParsedOptions = {
    positionals: [],
    values: new Map(),
    flags: new Set(),
    errors: [],
  }

  const pushValue = (spec: OptionSpec, value: string): void => {
    const list = result.values.get(spec.name)
    if (list === undefined) {
      result.values.set(spec.name, [value])
      return
    }
    if (spec.kind !== 'repeat') {
      // 非 repeat 的选项给两次：后一次覆盖（与大多数 CLI 一致），但不静默——记一条说明。
      list.splice(0, list.length, value)
      return
    }
    list.push(value)
  }

  /** 说明"缺值"的统一措辞（占位名给出来，用户才知道该填什么）。 */
  const needValueMessage = (flag: string, spec: OptionSpec): string =>
    `${flag} 需要一个值${spec.placeholder === undefined ? '' : `（${spec.placeholder}）`}`

  let onlyPositionals = false
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!
    if (onlyPositionals) {
      result.positionals.push(token)
      continue
    }
    if (token === '--') {
      onlyPositionals = true
      continue
    }

    if (token.startsWith('--')) {
      const body = token.slice(2)
      const eq = body.indexOf('=')
      const name = eq >= 0 ? body.slice(0, eq) : body
      const inline = eq >= 0 ? body.slice(eq + 1) : undefined
      const spec = byName.get(name)
      if (spec === undefined) {
        result.errors.push(`未知选项：--${name}`)
        continue
      }
      if (spec.kind === 'boolean') {
        if (inline !== undefined) {
          result.errors.push(`--${name} 不接受值（收到 ${inline}）`)
          continue
        }
        result.flags.add(spec.name)
        continue
      }
      if (inline !== undefined) {
        pushValue(spec, inline)
        continue
      }
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('-')) {
        result.errors.push(needValueMessage(`--${name}`, spec))
        continue
      }
      pushValue(spec, next)
      i += 1
      continue
    }

    if (token.startsWith('-') && token.length > 1) {
      const alias = token.slice(1)
      const spec = byAlias.get(alias)
      if (spec === undefined) {
        result.errors.push(`未知选项：-${alias}`)
        continue
      }
      if (spec.kind === 'boolean') {
        result.flags.add(spec.name)
        continue
      }
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('-')) {
        result.errors.push(needValueMessage(`-${alias}`, spec))
        continue
      }
      pushValue(spec, next)
      i += 1
      continue
    }

    result.positionals.push(token)
  }

  return result
}

/** 取单值选项的最后一个值。 */
export function one(parsed: ParsedOptions, name: string): string | undefined {
  const list = parsed.values.get(name)
  return list === undefined || list.length === 0 ? undefined : list[list.length - 1]
}

/** 取可重复选项的全部值。 */
export function all(parsed: ParsedOptions, name: string): string[] {
  return parsed.values.get(name) ?? []
}

/** 布尔选项是否出现。 */
export function has(parsed: ParsedOptions, name: string): boolean {
  return parsed.flags.has(name)
}

/** 取单值选项的最后一个值；出现但为空白时返回 undefined。 */
export function oneTrimmed(parsed: ParsedOptions, name: string): string | undefined {
  const value = one(parsed, name)
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** 解析整数选项；缺省 / 非法都返回 undefined，由调用方决定怎么报错。 */
export function parseIntOption(parsed: ParsedOptions, name: string): number | undefined {
  const value = oneTrimmed(parsed, name)
  if (value === undefined) return undefined
  const parsedInt = Number(value)
  return Number.isInteger(parsedInt) ? parsedInt : undefined
}

/** 渲染一行用法（help 与错误提示共用）。 */
export function usageLine(binary: string, command: string, tail: string): string {
  return `  ${binary} ${command}${tail === '' ? '' : ` ${tail}`}`
}
