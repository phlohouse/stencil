"""Self-contained schema map review page."""

from __future__ import annotations

import json

STYLES = """
body{margin:24px;background:white;color:#172033;font:15px system-ui,sans-serif}
h2{font-size:21px;margin-bottom:6px}
p{color:#64748b;line-height:1.5}article{margin:42px 0 60px}
img{display:block;width:auto;height:auto;max-width:none}
.sheet-image{position:relative;border:1px solid #e2e8f0}
.range-review{position:absolute;border:0;padding:0;background:transparent;cursor:pointer}
.range-review:hover,.range-review:focus-visible{outline:2px solid #172033;background:#ffffff33}
.range-review[data-action="remove"]{outline:2px solid #dc2626;background:#ef444433}
.range-review[data-action="remove"]:after{content:'';position:absolute;left:0;right:0;top:50%;border-top:2px solid #b91c1c}
.range-review[data-action="change"]{outline:2px solid #d97706;background:#f59e0b33}
button{font:inherit;cursor:pointer;border:1px solid #cbd5e1;border-radius:5px;background:white;padding:8px 12px}
button.primary{background:#172033;color:white;border-color:#172033}
button.danger{color:#b91c1c;border-color:#fca5a5}
button:disabled{opacity:.45;cursor:default}
#open-summary{position:fixed;right:20px;bottom:20px;z-index:5;box-shadow:0 2px 12px #0002}
dialog{border:1px solid #cbd5e1;border-radius:9px;max-width:min(680px,90vw);width:640px;padding:24px;color:#172033}
dialog::backdrop{background:#17203366}dialog h2{margin:0 0 10px}
label{display:block;margin:16px 0 5px;font-size:13px}input[type=text],textarea{box-sizing:border-box;width:100%;padding:9px;border:1px solid #cbd5e1;border-radius:4px;font:13px ui-monospace,monospace}
textarea{resize:vertical}#summary-text{min-height:300px}#edit-context{white-space:pre-wrap;font:12px ui-monospace,monospace;line-height:1.6;color:#475569;background:#f8fafc;padding:12px}
.scope{display:flex;gap:8px;align-items:center}.actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:18px}.hint{font-size:12px}#edit-error,#copy-status{font-size:13px}
@media print{#open-summary,.range-review,dialog{display:none}}
"""
REVIEW_UI = """
<button id="open-summary" type="button" class="primary">Review summary (0)</button>
<dialog id="edit-dialog" aria-labelledby="edit-title">
<h2 id="edit-title">Review range</h2><div id="edit-context"></div>
<label for="new-range">Replacement source cell or range, optional</label>
<input id="new-range" type="text" placeholder="For example: Analysis!F34:P36">
<label for="review-note">What should change?</label>
<textarea id="review-note" rows="3" placeholder="Describe the change, or add a reason for removal."></textarea>
<label class="scope"><input id="all-versions" type="checkbox"> Apply to all versions of this schema</label>
<p id="edit-error" role="alert"></p>
<div class="actions"><button id="save-remove" type="button" class="danger">Mark for removal</button><button id="save-change" type="button" class="primary">Save change</button><button id="clear-request" type="button">Undo request</button><button id="cancel-edit" type="button">Cancel</button></div>
</dialog>
<dialog id="summary-dialog" aria-labelledby="summary-title">
<h2 id="summary-title">Review summary</h2><p>Copy this text and paste it into the chat. The schemas have not been changed.</p>
<textarea id="summary-text" readonly aria-label="Schema change summary"></textarea>
<p id="copy-status" role="status"></p>
<div class="actions"><button id="copy-summary" type="button" class="primary">Copy summary</button><button id="close-summary" type="button">Close</button></div>
</dialog>
"""
SCRIPT = r"""
const storageKey=__STORAGE_KEY__;
const buttons=[...document.querySelectorAll('.range-review')];
const fields=new Map(buttons.map(button=>{const field=JSON.parse(button.dataset.field);return[field.id,field]}));
const requests=new Map();
let storageAvailable=true;
try{
 const saved=JSON.parse(localStorage.getItem(storageKey)||localStorage.getItem('pcr-schema-map-review-v1')||'[]');
 if(Array.isArray(saved))for(const request of saved){
  const field=fields.get(request?.id);
  if(field&&request.current===field.current&&['remove','change'].includes(request.action)
   &&typeof request.note==='string'&&typeof request.replacement==='string'&&typeof request.allVersions==='boolean'){
   requests.set(field.id,{...field,action:request.action,note:request.note,replacement:request.replacement,allVersions:request.allVersions});
  }
 }
}catch{storageAvailable=false}
const edit=document.getElementById('edit-dialog');
const summaryDialog=document.getElementById('summary-dialog');
const replacement=document.getElementById('new-range');
const note=document.getElementById('review-note');
const allVersions=document.getElementById('all-versions');
const summary=document.getElementById('summary-text');
let selected=null;
function summaryText(){
 if(!requests.size)return 'No schema changes marked yet. Click a coloured range label to add a request.';
 const blocks=[...requests.values()].map(request=>[
  'Schema: '+request.schema,'Version shown: '+request.version,'Sheet: '+request.sheet,
  'Key: '+request.key,'Current source: '+request.current,
  'Scope: '+(request.allVersions?'All versions of this schema':'Only the version shown'),
  'Action: '+request.action.toUpperCase(),
  ...(request.action==='change'&&request.replacement?['Replacement source: '+request.replacement]:[]),
  ...(request.note?['Note: '+request.note]:[])
 ].join('\n'));
 return 'Requested schema mapping changes ('+requests.size+')\n\n'+blocks.join('\n\n');
}
function update(){
 for(const button of buttons){const request=requests.get(JSON.parse(button.dataset.field).id);if(request)button.dataset.action=request.action;else delete button.dataset.action}
 document.getElementById('open-summary').textContent='Review summary ('+requests.size+')';
 summary.value=summaryText();
 document.getElementById('copy-summary').disabled=!requests.size;
 try{localStorage.setItem(storageKey,JSON.stringify([...requests.values()]))}catch{storageAvailable=false}
 document.getElementById('copy-status').textContent=storageAvailable?'Changes are saved in this browser.':'Browser storage is unavailable. Copy the summary before refreshing or closing this page.';
}
for(const button of buttons)button.addEventListener('click',()=>{
 selected=JSON.parse(button.dataset.field);
 const request=requests.get(selected.id);
 document.getElementById('edit-title').textContent=selected.key;
 document.getElementById('edit-context').textContent=selected.schema+'\nVersion: '+selected.version+'\nSheet: '+selected.sheet+'\nCurrent: '+selected.current+' ('+selected.kind+')';
 replacement.value=request?.replacement||'';note.value=request?.note||'';allVersions.checked=request?.allVersions||false;
 document.getElementById('clear-request').disabled=!request;
 document.getElementById('edit-error').textContent='';edit.showModal();
});
function save(action){
 const value=replacement.value.trim(), explanation=note.value.trim();
 if(action==='change'&&!value&&!explanation){document.getElementById('edit-error').textContent='Enter a replacement source or describe the requested change.';return}
 requests.set(selected.id,{...selected,action,replacement:action==='change'?value:'',note:explanation,allVersions:allVersions.checked});
 update();edit.close();
}
document.getElementById('save-remove').addEventListener('click',()=>save('remove'));
document.getElementById('save-change').addEventListener('click',()=>save('change'));
document.getElementById('clear-request').addEventListener('click',()=>{requests.delete(selected.id);update();edit.close()});
document.getElementById('cancel-edit').addEventListener('click',()=>edit.close());
document.getElementById('open-summary').addEventListener('click',()=>{update();summaryDialog.showModal()});
document.getElementById('close-summary').addEventListener('click',()=>summaryDialog.close());
document.getElementById('copy-summary').addEventListener('click',async()=>{
 try{await navigator.clipboard.writeText(summary.value);document.getElementById('copy-status').textContent='Copied. Paste the summary into the chat.'}
 catch{summary.focus();summary.select();document.getElementById('copy-status').textContent='Summary selected. Press Ctrl+C or Cmd+C, then paste into the chat.'}
});
update();
"""


def render_page(panels: list[str], storage_key: str) -> str:
    script = SCRIPT.replace("__STORAGE_KEY__", json.dumps(storage_key))
    return (
        '<!doctype html><html lang="en"><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f"<title>Schema maps</title><style>{STYLES}</style>"
        f"<main>{''.join(panels)}</main>{REVIEW_UI}<script>{script}</script></html>"
    )
