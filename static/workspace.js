/* The workspace reflects real app state; it does not simulate conversation or model results. */
(function () {
 'use strict';
 document.addEventListener('DOMContentLoaded', function () {
  const byId=id=>document.getElementById(id);
  const input=byId('description');
  const visible=element=>!element.classList.contains('hidden');
  const write=(element,value)=>{if(element.textContent!==value)element.textContent=value;};
  let phase='describe';
  function capturePrompt(){
   if(!input.value.trim())return;
   write(byId('sent-description'),input.value.trim());
   byId('user-message').classList.remove('hidden');
  }
  byId('profile-btn').addEventListener('click',capturePrompt);
  byId('direct-btn').addEventListener('click',capturePrompt);
  input.addEventListener('keydown',function(event){
   if((event.ctrlKey||event.metaKey)&&event.key==='Enter'&&!event.isComposing){
    event.preventDefault();
    if(!byId('profile-btn').disabled)byId('profile-btn').click();
   }
  });
  function clearSent(){byId('user-message').classList.add('hidden');}
  input.addEventListener('input',clearSent);
  document.querySelectorAll('.scenario,.chip').forEach(button=>button.addEventListener('click',clearSent));
  document.querySelectorAll('.new-exploration').forEach(button=>button.addEventListener('click',function(){
   input.value=''; byId('city').value='';
   input.dispatchEvent(new Event('input',{bubbles:true}));
   write(byId('tips'),'');
   byId('input-panel').scrollIntoView({behavior:'smooth',block:'center'});
   input.focus({preventScroll:true});
  }));
  document.querySelectorAll('[data-goto]').forEach(button=>button.addEventListener('click',function(){
   const target=byId(button.dataset.goto);
   if(target&&!button.disabled){target.scrollIntoView({behavior:'smooth',block:'start'});if(target.id==='input-panel')input.focus({preventScroll:true});}
  }));
  function sync(){
   const hasProfile=visible(byId('profile-area'));
   const hasResult=visible(byId('result-area'));
   const conflict=visible(byId('conflict-box'));
   const loading=byId('profile-btn').disabled;
   const next=loading?'loading':conflict?'conflict':hasResult?'results':hasProfile?'profile':'describe';
   document.body.dataset.phase=next;
   const active=hasResult?'result-area':hasProfile?'profile-area':'input-panel';
   document.querySelectorAll('[data-goto]').forEach(button=>{
    const id=button.dataset.goto;
    button.disabled=id==='profile-area'?!hasProfile:id==='result-area'?!hasResult:false;
    button.classList.toggle('active',id===active);
    if(id===active)button.setAttribute('aria-current','step');else button.removeAttribute('aria-current');
   });
   const stage=hasResult?2:hasProfile?1:0;
   document.querySelectorAll('.session-steps li').forEach((item,index)=>{
    item.classList.toggle('current',index===stage);item.classList.toggle('done',index<stage);
    if(index===1){
     const skipped=hasResult&&!hasProfile;
     write(item.querySelector('strong'),skipped?'本次跳过画像':'确认你的画像');
     write(item.querySelector('small'),skipped?'按关键词直接匹配':'可修改，不替你做决定');
     if(skipped)item.classList.remove('done');
    }
   });
   const cards=byId('cards').querySelectorAll('.card').length;
   const pending=byId('cards').querySelectorAll('.copy-loading').length;
   const failed=byId('cards').querySelectorAll('.copy-error').length;
   const warning=byId('tips').classList.contains('warn');
   const message=loading?'正在理解你的描述…':conflict?'有偏好相互冲突，请先修改。':hasResult?
    (pending?'已找到 '+cards+' 个景点，正在逐个生成文案。':failed?failed+' 条文案暂未生成，可在卡片中重试。':'已推荐 '+cards+' 个景点，可编辑文案并导出。'):
    warning?'请查看输入区提示，调整后再试。':hasProfile?'画像已整理好，等你核对确认。':'等你说说，这次想怎样旅行。';
   write(byId('session-status'),message);
   const preview=byId('preference-preview');
   if(hasProfile){
    const rows=[...byId('profile-list').querySelectorAll('.profile-row')];
    const data=rows.map(row=>({label:row.querySelector('.profile-label')?.textContent.trim(),value:row.querySelector('.profile-value')?.textContent.trim()||row.querySelector('input')?.value||'未说明'}));
    const signature=JSON.stringify(data);
    if(preview.dataset.signature!==signature){
     preview.replaceChildren();
     data.forEach(item=>{
      const row=document.createElement('div');row.className='preference-item';
      const label=document.createElement('span');label.textContent=item.label;
      const value=document.createElement('strong');value.textContent=item.value;
      if(item.value==='未说明')value.className='unknown';
      row.append(label,value);preview.append(row);
     });
     preview.dataset.signature=signature;
    }
   }else if(preview.dataset.signature!=='empty'){
    preview.innerHTML='<p class="empty-preferences">你的描述会变成一份<br>可以修改的旅行偏好画像。</p><div class="empty-tags"><span>喜欢什么</span><span>想怎么玩</span><span>不做什么</span></div>';
    preview.dataset.signature='empty';
   }
   if(next!==phase&&((next==='profile'&&phase==='loading')||next==='results'||next==='conflict')){
    const target=byId(next==='results'?'result-area':next==='conflict'?'conflict-box':'profile-area');
    requestAnimationFrame(()=>target.scrollIntoView({behavior:'smooth',block:'start'}));
   }
   phase=next;
  }
  const observer=new MutationObserver(sync);
  ['profile-area','result-area','conflict-box','cards','profile-btn','tips'].forEach(id=>observer.observe(byId(id),{attributes:true,attributeFilter:['class','disabled'],childList:true,characterData:true,subtree:true}));
  sync();
 });
})();
