/* 演示记录只保留业务信息，提供可读文本和结构化导出。 */
(function (global) {
  'use strict';
  const labels = {companion:'同行偏好',environment:'环境偏好',pace:'行程节奏',stamina:'体力接受度',interests:'内容兴趣',excludes:'明确排除项'};
  const clone = value => JSON.parse(JSON.stringify(value));
  function create(input, city, profile, initialProfile, mode, results, status, message) {
    return {
      version:'3.1', createdAt:new Date().toISOString(), input, city:city || '不限城市',
      generationMode:mode, matchingMethod:'本地标签与经核验属性规则',
      initialProfile:clone(initialProfile || {}), confirmedProfile:clone(profile || {}),
      status, message:message || '', results:results.map(r => ({
        id:r.spot.id, name:r.spot.name, city:r.spot.city,
        source:r.spot.source, verifiedDate:r.spot.verified_date, image:r.spot.image,
        sourceScope:r.spot.source && new URL(r.spot.source).pathname === '/' ? '官网首页，待补具体页面；未逐条核验' : '具体资料页面；核验范围见数据检查记录',
        mediaNote:r.spot.note, licenseClaim:r.spot.license,
        matched:clone(r.matched), unconfirmed:clone(r.unconfirmed), mismatched:clone(r.mismatched),
        copyStatus:'pending', original:null, final:null, edits:[], reviewed:false
      }))
    };
  }
  function setGenerated(item, title, copy) {
    item.original={title,copy}; item.final={title,copy}; item.copyStatus='success';
  }
  function saveEdit(item,title,copy) {
    title=title.trim(); copy=copy.trim();
    if (!title || !copy) throw new Error('标题和文案不能为空。');
    if (item.final.title !== title || item.final.copy !== copy) {
      item.edits.push({at:new Date().toISOString(),before:clone(item.final),after:{title,copy}});
      item.final={title,copy}; item.reviewed=false;
    }
  }
  function toText(run) {
    const out=['鲁趣寻踪 · 演示记录','时间：'+run.createdAt,'生成模式：'+run.generationMode,
      '匹配方式：'+run.matchingMethod,'原始输入：'+run.input,'城市：'+run.city,'状态：'+run.status,run.message,'','用户确认的旅行偏好'];
    Object.keys(labels).forEach(k=>{
      const p=run.confirmedProfile[k] || {}; const val=Array.isArray(p.value)?p.value.join('、'):(p.value || '未说明');
      out.push(labels[k]+'：'+val+(p.evidence?'（'+p.evidence+'）':''));
    });
    run.results.forEach(item=>{
      out.push('',item.name+'（'+item.city+'）','景点ID：'+item.id,
        '符合：'+item.matched.map(x=>x.label+'：'+x.evidence).join('；'),
        '尚不能确认：'+item.unconfirmed.map(x=>x.note).join('；'),
        '不符：'+item.mismatched.map(x=>x.note).join('；'),
        '事实来源：'+(item.source||'未提供'),'表格核验日期：'+(item.verifiedDate||'未提供'),
        '来源范围：'+item.sourceScope,'图片链接：'+(item.image||'未提供'),
        '素材说明：'+(item.mediaNote||'未提供'),'表格所列授权：'+(item.licenseClaim||'未提供'),'文案状态：'+item.copyStatus);
      if(item.original) out.push('生成初稿：',item.original.title,item.original.copy);
      if(item.final) out.push('当前文案：',item.final.title,item.final.copy,'正文字符数（含标点）：'+Array.from(item.final.copy).length);
      out.push('人工修改次数：'+item.edits.length,'使用者勾选已审阅：'+(item.reviewed?'是':'否'));
      item.edits.forEach((edit,i)=>out.push('修改 '+(i+1)+'（'+edit.at+'）：',
        '修改前：'+edit.before.title+'\n'+edit.before.copy,'修改后：'+edit.after.title+'\n'+edit.after.copy));
      if(item.error)out.push('失败说明：'+item.error);
    });
    out.push('','说明：未知属性不代表不适合；生成文案与素材使用范围仍需人工核验。');
    return out.join('\n');
  }
  global.DemoRecords={create,setGenerated,saveEdit,toText};
})(typeof window!=='undefined'?window:globalThis);
