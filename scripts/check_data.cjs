/* Expanded-data checks; no browser and no paid model calls. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const spots = JSON.parse(fs.readFileSync(path.join(root,'data/attractions.json'),'utf8'));
const attrs = JSON.parse(fs.readFileSync(path.join(root,'data/attributes.json'),'utf8'));
const M = require('../static/matcher.js');
const spot = id => spots.find(s=>s.id===id);
const tests=[];
function test(name,check){check();tests.push(name);}
test('80条数据及ID唯一',()=>{assert.equal(spots.length,80);assert.equal(new Set(spots.map(s=>s.id)).size,80);});
test('14个城市',()=>assert.equal(new Set(spots.map(s=>s.city)).size,14));
test('80条属性均有记录',()=>assert(spots.every(s=>attrs[s.id])));
test('不爬山覆盖新增登山标签及限制提醒',()=>['SD001','SD025','SD034','SD039','SD045','SD046','SD055','SD056','SD060','SD075'].forEach(id=>assert(M.isExcluded(spot(id),['爬山']),id)));
test('海滨散步不因山字误剔除',()=>assert(!M.isExcluded(spot('SD038'),['爬山'])));
test('建筑摄影组合命中八大关',()=>assert(M.matchWord(spot('SD009'),'建筑摄影').matched));
test('海边标签不能独立证明可拍照',()=>assert(!M.matchWord(spot('SD024'),'拍照').matched));
test('登山与排除爬山冲突',()=>assert(M.detectConflicts({interests:{value:['登山']},excludes:{value:['爬山']}}).length));
test('新增亲子景点在德州可召回',()=>assert(M.matchAll({companion:{value:'亲子'}},spots,attrs,'德州',3).some(r=>r.spot.id==='SD079')));
test('资料写明慢生活可参与节奏匹配',()=>assert(M.matchByProfile({pace:{value:'轻松'}},spot('SD027'),attrs).matched.some(r=>r.dim==='pace')));
test('不把慢生活推断成低体力',()=>assert(!attrs.SD027.stamina.known));
test('全部未核验体力均不参与计分',()=>assert(spots.every(s=>!attrs[s.id].stamina.known)));
test('新增海岸景点召回且城市过滤有效',()=>{const r=M.matchAll({environment:{value:'海边'}},spots,attrs,'日照',3);assert(r.length);assert(r.every(s=>s.spot.city==='日照'));assert(r.some(s=>s.spot.id==='SD072'));});
test('三张存疑配图不展示',()=>['SD004','SD019','SD056'].forEach(id=>{assert.equal(spot(id).image,'');assert(spot(id).note.includes('配图待核验'));}));
test('潭溪山等级及仰天山地点修正',()=>{assert(spot('SD045').tags.includes('4A级景区'));assert(spot('SD060').intro.includes('青州市'));});
console.log(JSON.stringify({passed:true,checks:tests,real_model_requests:0},null,2));
