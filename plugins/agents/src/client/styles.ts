const PLUGIN_ID = '@banbolee/dsh-agents'
const STYLE_ID = `${PLUGIN_ID}/client.css`

export const styles = Object.freeze({
  card: 'banboAgents_card',
  switch: 'banboAgents_switch',
  rows: 'banboAgents_rows',
  row: 'banboAgents_row',
  rowHead: 'banboAgents_rowHead',
  retired: 'banboAgents_retired',
  model: 'banboAgents_model',
  notice: 'banboAgents_notice',
  error: 'banboAgents_error',
})

const CSS_TEXT = `
.banboAgents_card{display:flex;flex-direction:column;gap:16px;padding:18px;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.banboAgents_card h3,.banboAgents_card p{margin:0}.banboAgents_card header p,.banboAgents_notice{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}
.banboAgents_switch,.banboAgents_rowHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.banboAgents_switch>span{display:flex;flex:1;flex-direction:column;gap:3px}.banboAgents_switch small{color:var(--dsw-alias-label-tertiary)}
.banboAgents_rows{display:flex;flex-direction:column;gap:10px}.banboAgents_row{display:flex;flex-direction:column;gap:10px;padding:14px;border:.5px solid var(--dsw-alias-border-l4);border-radius:10px}
.banboAgents_rowHead code{margin-left:8px;color:var(--dsw-alias-label-tertiary);font-size:11px}.banboAgents_rowHead p{margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:12px}.banboAgents_retired{color:var(--dsw-alias-label-warning);font-size:12px;font-weight:600}
.banboAgents_model{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;border:0;padding:0;margin:0}.banboAgents_model legend{grid-column:1/-1;padding:0;font-size:12px;font-weight:600}.banboAgents_model label{display:flex;flex-direction:column;gap:4px;color:var(--dsw-alias-label-secondary);font-size:11px}.banboAgents_model input{min-width:0;height:32px;border:.5px solid var(--dsw-alias-border-l4);border-radius:7px;padding:0 9px;color:inherit;background:var(--dsw-alias-bg-layer-3)}.banboAgents_model button{grid-column:1/-1;justify-self:start}
.banboAgents_card button{border:.5px solid var(--dsw-alias-border-l4);border-radius:7px;padding:6px 10px;color:inherit;background:var(--dsw-alias-bg-layer-3);cursor:pointer}.banboAgents_card button:disabled{cursor:default;opacity:.5}.banboAgents_card details{font-size:12px}.banboAgents_card dl{display:grid;grid-template-columns:max-content 1fr;gap:5px 12px;margin-bottom:0}.banboAgents_card dt{color:var(--dsw-alias-label-tertiary)}.banboAgents_card dd{margin:0;overflow-wrap:anywhere}.banboAgents_error{color:var(--dsw-alias-label-error);font-size:12px}.banboAgents_card footer{display:flex;justify-content:flex-end;gap:8px}
@media(max-width:720px){.banboAgents_model{grid-template-columns:1fr}.banboAgents_model button,.banboAgents_model legend{grid-column:1}}
`

/**
 * Install one HMR-owned style at client factory materialization time.
 *
 * @returns the disposer that removes the tag this call created. It is a no-op
 *   when a tag already existed, because that one belongs to whoever created it.
 */
export function installClientStyle(): () => void {
  if (typeof document === 'undefined') return () => {}
  const selector = `style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`
  const existing = document.querySelector(selector)
  if (existing !== null) {
    // Adopt the tag we find: a duplicate materialization must not leak one, and
    // the caller still owns teardown of the plugin's own style.
    return () => { existing.remove() }
  }
  const tag = document.createElement('style')
  tag.dataset.plugin = PLUGIN_ID
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = CSS_TEXT
  document.head.appendChild(tag)
  return () => { tag.remove() }
}
