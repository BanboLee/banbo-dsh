import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsPluginItemOwnerProps } from '@deepseek-ai/dsh-client-ui-settings-plugins/client'

import type { AgentModelView } from '@banbolee/dsh-agents/catalog-remote'
import type { AgentsSettingsController, AgentsSettingsSnapshot } from './controller.js'
import { styles } from './styles.js'

void (undefined as SettingsPluginItemOwnerProps | undefined)

export const LOCALE_NAMESPACE = 'banbo.agents'

export type AgentsLocaleKey =
  | 'title' | 'description' | 'includeDefaults' | 'includeDefaultsHint'
  | 'enabled' | 'model' | 'provider' | 'modelId' | 'reasoningEffort'
  | 'inheritModel' | 'save' | 'discard' | 'saving' | 'writeFailed' | 'conflict'
  | 'retired' | 'retiredMainHint' | 'retiredChildHint' | 'structure' | 'forms' | 'children' | 'tools'
  | 'budget' | 'empty' | 'effectsHint' | 'restartHint' | 'mainModelHint'

export const dictionaries: Record<'zh' | 'en', Record<AgentsLocaleKey, string>> = {
  zh: {
    title: 'Banbo Agent',
    description: '管理后续创建与委派使用的 Agent 开关和子 Agent 模型。',
    includeDefaults: '启用内置 Agent',
    includeDefaultsHint: '作为未单独设置的内置 Agent 的默认开关。',
    enabled: '启用', model: '子 Agent 模型', provider: 'Provider', modelId: 'Model', reasoningEffort: 'Reasoning effort（可选）',
    inheritModel: '使用目录默认模型', save: '保存', discard: '放弃更改', saving: '保存中…',
    writeFailed: '保存未生效，已保留草稿。', conflict: '设置已在其他位置更新。请放弃草稿后重新编辑。',
    retired: '已退役',
    retiredMainHint: '定义已删除；该主 Agent 的旧 Session 及其整棵子树不再可恢复。如需恢复，请重新提供 YAML 并重启。',
    retiredChildHint: '定义已删除；不再可被委派。已有 continuable child 仍可恢复，但对它的新委派一律拒绝。',
    structure: '只读结构', forms: '形态', children: '可委派 Agent', tools: '工具能力', budget: '主 Agent 预算', empty: '无',
    effectsHint: '开关影响后续创建/委派；子 Agent 模型在下一次委派生效。当前运行中的 Session 不改变。',
    restartHint: 'persona、授权图、工具和预算需编辑 YAML/Markdown 并重启。',
    mainModelHint: '主 Agent 模型不由此卡片设置，请使用官方 Session 模型选择器。',
  },
  en: {
    title: 'Banbo Agent',
    description: 'Manage agent availability and child-agent models for subsequent creation and delegation.',
    includeDefaults: 'Enable built-in agents',
    includeDefaultsHint: 'Default for built-in agents without an individual override.',
    enabled: 'Enabled', model: 'Child-agent model', provider: 'Provider', modelId: 'Model', reasoningEffort: 'Reasoning effort (optional)',
    inheritModel: 'Use catalog default', save: 'Save', discard: 'Discard changes', saving: 'Saving…',
    writeFailed: 'The save did not land; your draft is preserved.', conflict: 'Settings changed elsewhere. Discard this draft and edit the latest revision.',
    retired: 'Retired',
    retiredMainHint: 'The definition was removed. Old sessions of this main agent and its whole subtree can no longer be recovered. Restore the YAML and restart to bring it back.',
    retiredChildHint: 'The definition was removed. It can no longer be delegated to. Existing continuable children stay recoverable, but every new delegation to it is refused.',
    structure: 'Read-only structure', forms: 'Forms', children: 'Allowed children', tools: 'Tool capabilities', budget: 'Main-agent budget', empty: 'None',
    effectsHint: 'Enabled changes affect subsequent creation/delegation; child models affect the next delegation. Running sessions do not change.',
    restartHint: 'Edit YAML/Markdown and restart to change personas, delegation edges, tools, or budgets.',
    mainModelHint: 'Main-agent models are controlled by the official Session model selector, not this card.',
  },
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'banbo.agents': AgentsLocaleKey
  }
}

export interface AgentsSettingsCardFace {
  hooks: {
    agentsSettings: Pick<AgentsSettingsController, 'getSnapshot' | 'subscribe'>
  }
  stageIncludeDefaults(value: boolean): void
  stageEnabled(agentId: string, value: boolean): void
  stageModel(agentId: string, value: AgentModelView | undefined): void
  save(): void
  discard(): void
}

export type AgentsSettingsCardProps = PropsRuntime<'settings.plugin.item'>
  & PropsLocale<typeof LOCALE_NAMESPACE>
  & InjectFace<AgentsSettingsCardFace>

function textList(values: readonly string[], empty: string): string {
  return values.length === 0 ? empty : values.join(', ')
}

function ModelEditor(props: {
  row: AgentsSettingsSnapshot['rows'][number]
  disabled: boolean
  t: AgentsSettingsCardProps['t']
  stage(value: AgentModelView | undefined): void
}) {
  const [provider, setProvider] = useState(props.row.model?.provider ?? '')
  const [model, setModel] = useState(props.row.model?.model ?? '')
  const [reasoningEffort, setReasoningEffort] = useState(props.row.model?.reasoningEffort ?? '')
  useEffect(() => {
    setProvider(props.row.model?.provider ?? '')
    setModel(props.row.model?.model ?? '')
    setReasoningEffort(props.row.model?.reasoningEffort ?? '')
  }, [props.row.model?.provider, props.row.model?.model, props.row.model?.reasoningEffort])

  const stage = (nextProvider: string, nextModel: string, nextEffort: string) => {
    if (nextProvider === '' || nextModel === '') return
    props.stage({
      provider: nextProvider,
      model: nextModel,
      ...(nextEffort === '' ? {} : { reasoningEffort: nextEffort }),
    })
  }

  return <fieldset className={styles.model} disabled={props.disabled}>
    <legend>{props.t('model')}</legend>
    <label>{props.t('provider')}<input value={provider} onChange={(event) => {
      const next = event.currentTarget.value
      setProvider(next)
      stage(next, model, reasoningEffort)
    }} /></label>
    <label>{props.t('modelId')}<input value={model} onChange={(event) => {
      const next = event.currentTarget.value
      setModel(next)
      stage(provider, next, reasoningEffort)
    }} /></label>
    <label>{props.t('reasoningEffort')}<input value={reasoningEffort} onChange={(event) => {
      const next = event.currentTarget.value
      setReasoningEffort(next)
      stage(provider, model, next)
    }} /></label>
    <button type="button" onClick={() => props.stage(undefined)}>{props.t('inheritModel')}</button>
  </fieldset>
}

/** Plugin Configuration card for the startup catalog plus official live settings. */
export function AgentSettingsCard(props: AgentsSettingsCardProps) {
  const state = props.useAgentsSettings((snapshot: AgentsSettingsSnapshot) => snapshot)
  if (!state.available) return null
  const disabled = !state.writable || state.saving || state.conflicted

  return <section className={styles.card} data-banbo-agents-card>
    <header><h3>{props.t('title')}</h3><p>{props.t('description')}</p></header>
    <label className={styles.switch}>
      <input type="checkbox" checked={state.includeDefaults} disabled={disabled}
        onChange={(event) => props.stageIncludeDefaults(event.currentTarget.checked)} />
      <span><strong>{props.t('includeDefaults')}</strong><small>{props.t('includeDefaultsHint')}</small></span>
    </label>
    <div className={styles.rows}>
      {state.rows.map((row: AgentsSettingsSnapshot['rows'][number]) => <article className={styles.row} key={row.id}>
        <div className={styles.rowHead}>
          <div><strong>{row.displayName}</strong><code>{row.id}</code><p>{row.description}</p></div>
          {row.source === 'retired'
            ? <span className={styles.retired}>{props.t('retired')}</span>
            : <label><input type="checkbox" checked={row.enabled} disabled={disabled || !row.enabledEditable}
                onChange={(event) => props.stageEnabled(row.id, event.currentTarget.checked)} /> {props.t('enabled')}</label>}
        </div>
        {row.source === 'retired'
          // The two retirement shapes have materially different recovery
          // consequences: a removed `main` form takes its whole subtree with
          // it, while a child-only removal leaves existing continuable children
          // recoverable. The card is the only in-product place that says which
          // one applies (§12.1).
          ? <p className={styles.notice}>{props.t(row.forms.includes('main') ? 'retiredMainHint' : 'retiredChildHint')}</p>
          : null}
        {row.modelEditable ? <ModelEditor row={row} disabled={disabled} t={props.t}
          stage={(value) => props.stageModel(row.id, value)} /> : null}
        {row.forms.includes('main') ? <p className={styles.notice}>{props.t('mainModelHint')}</p> : null}
        <details><summary>{props.t('structure')}</summary><dl>
          <dt>{props.t('forms')}</dt><dd>{textList(row.forms, props.t('empty'))}</dd>
          <dt>{props.t('children')}</dt><dd>{textList(row.allowedChildren, props.t('empty'))}</dd>
          <dt>{props.t('tools')}</dt><dd>{textList(row.toolCapabilities, props.t('empty'))}</dd>
          {row.mainBudgetSummary === undefined ? null : <><dt>{props.t('budget')}</dt><dd>{Object.entries(row.mainBudgetSummary).map(([key, value]) => `${key}: ${value}`).join(', ')}</dd></>}
        </dl></details>
      </article>)}
    </div>
    <p className={styles.notice}>{props.t('effectsHint')}</p>
    <p className={styles.notice}>{props.t('restartHint')}</p>
    {state.failed ? <p className={styles.error} role="status">{props.t('writeFailed')}</p> : null}
    {state.conflicted ? <p className={styles.error} role="status">{props.t('conflict')}</p> : null}
    <footer>
      <button type="button" disabled={!state.dirty || state.saving} onClick={props.discard}>{props.t('discard')}</button>
      <button type="button" disabled={!state.dirty || disabled} onClick={props.save}>{state.saving ? props.t('saving') : props.t('save')}</button>
    </footer>
  </section>
}
