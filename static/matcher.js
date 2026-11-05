/*
 * 鲁趣寻踪 —— 画像驱动的景点匹配引擎（第三版）
 * 纯逻辑模块，无 DOM 依赖，可在浏览器与 Node 中运行。
 *
 * 设计原则：
 *  1. 排除项优先于兴趣加分（硬剔除）。
 *  2. 兴趣与排除映射冲突时报告冲突，不擅自删除条件。
 *  3. 行程节奏/体力/同行只依据景点资料中有证据的属性（attributes.json 的 known=true）；
 *     资料未说明 → 标"尚不能确认"，不推断、不编造。
 *  4. 同行偏好仅在资料确有相关依据时参与比较。
 *  5. 匹配结果区分：符合（matched）/ 尚不能确认（unconfirmed）/ 与偏好不符（mismatched），均带资料依据。
 */
(function (global) {
  "use strict";

  // 口语化偏好词 → 表格中的真实标签（仅用于匹配辅助，不构成事实）
  var SYNONYMS = {
    "日出": ["日出云海", "最早日出"],
    "云海": ["日出云海"],
    "爬山": ["徒步登山", "登山", "爬山", "海上名山", "道教名山"],
    "登山": ["徒步登山", "登山", "爬山", "海上名山", "道教名山"],
    "徒步": ["徒步登山"],
    "看海": ["海滨", "海边", "海岸", "沙滩", "玻璃海", "海景", "海角奇观"],
    "海边": ["海滨", "海边", "海岸", "沙滩", "玻璃海", "海景", "海角奇观"],
    "拍照": ["拍照出片", "网红打卡", "海边拍照", "汉服拍照"],
    "摄影": ["拍照出片", "海边拍照", "网红打卡"],
    "出片": ["拍照出片", "网红打卡"],
    "打卡": ["网红打卡"],
    "网红": ["网红打卡"],
    "夜景": ["夜景", "夜景灯光", "夜景灯光秀", "灯光秀", "浮山湾夜景", "齐盛湖夜景", "夜游"],
    "夜游": ["夜游", "夜景"],
    "灯光": ["灯光秀", "夜景灯光", "夜景灯光秀"],
    "美食": ["美食", "烟火气", "紫米饼", "炒锅饼"],
    "吃": ["美食", "烟火气"],
    "小吃": ["美食", "烟火气"],
    "历史": ["历史文化", "百年历史", "历史文化街区", "世界文化遗产", "世界双遗产", "甲午战争纪念地", "古九州"],
    "文化": ["历史文化", "儒家文化", "历史文化街区", "世界文化遗产", "世界双遗产", "文化研学", "文化演出"],
    "古建筑": ["古建筑", "汉代建筑", "明清古城", "四大名楼"],
    "建筑": ["古建筑", "汉代建筑", "明清古城", "四大名楼", "最美书店"],
    "古城": ["运河古城", "明清古城", "古风小镇", "古九州"],
    "古镇": ["古风小镇", "明清古城"],
    "沙滩": ["钻石沙滩", "海水浴场"],
    "日落": ["日落海景"],
    "露营": ["草坪露营"],
    "骑行": ["环岛骑行"],
    "避暑": ["恒温18℃", "泉水景观", "自然湖泊"],
    "溶洞": ["特大型溶洞"],
    "漂流": ["暗河漂流"],
    "演出": ["文化演出", "沉浸式NPC"],
    "研学": ["文化研学", "红色教育"],
    "亲子": [],
    "红色": ["红色教育"],
    "汉服": ["汉服拍照"],
    "赏花": ["荷花季", "牡丹之都", "4-5月花期"],
    "书店": ["最美书店"],
    "浪漫": ["浪漫治愈", "日落海景"],
    "治愈": ["浪漫治愈"],
    "生态": ["湿地奇观", "黄蓝交汇"],
    "候鸟": ["候鸟迁徙", "海鸥季"],
    "海鸥": ["海鸥季"],
    "祈福": ["世界双遗产", "历史文化"],
    "八仙": ["八仙过海传说"],
    "神话": ["八仙过海传说", "海市蜃楼"],
    "日出海景": ["最早日出"],
    "城市": ["城市地标"],
    "山岳": ["五岳之首", "日出云海"],
    "自然": ["自然湖泊", "湿地", "泉水景观", "森林", "自然山水", "生态"],
    "博物馆": ["博物馆", "文物", "陶瓷文化", "琉璃艺术"],
    "非遗": ["非遗", "草编", "传统技艺"],
    "慢生活": ["慢生活", "慢节奏"],
    "慢节奏": ["慢节奏", "慢生活"]
  };

  // 一个标签是否被某个别名命中：
  // 只允许「标签包含别名」（如 标签「海边拍照」被别名「海边」命中），
  // 不允许「别名包含标签」（避免 别名「海边拍照」误配 标签「海边」）。
  function tagHit(tag, alias) {
    if (!alias) return false;
    if (tag === alias) return true;
    if (alias.length >= 2 && tag.includes(alias)) return true;
    return false;
  }

  function tryAliases(spot, aliases) {
    var hitTags = [];
    var matched = false;
    for (var i = 0; i < spot.tags.length; i++) {
      var tag = spot.tags[i];
      for (var j = 0; j < aliases.length; j++) {
        if (tagHit(tag, aliases[j])) {
          hitTags.push(tag);
          matched = true;
          break;
        }
      }
      if (matched) break;
    }
    return { matched: matched, hitTags: hitTags };
  }

  /*
   * 单个偏好词与景点的标签匹配。
   * 支持组合表达：如"建筑摄影" —— 先按整词/同义词匹配；未命中且为 4 字词时，
   * 拆成前2+后2 两个子词，要求两个子词都命中同一景点才算符合。
   */
  function matchWord(spot, word) {
    var aliases = [word].concat(SYNONYMS[word] || []);
    var r1 = tryAliases(spot, aliases);
    if (r1.matched) return { matched: true, hitTags: r1.hitTags, combo: false };

    if (word.length === 4) {
      var a = word.slice(0, 2);
      var b = word.slice(2, 4);
      if (SYNONYMS[a] && SYNONYMS[b]) {
        var ra = tryAliases(spot, [a].concat(SYNONYMS[a]));
        var rb = tryAliases(spot, [b].concat(SYNONYMS[b]));
        if (ra.matched && rb.matched) {
          return {
            matched: true,
            hitTags: ra.hitTags.concat(rb.hitTags),
            combo: true,
            parts: [a, b]
          };
        }
      }
    }
    return { matched: false, hitTags: [], combo: false };
  }

  // 检测画像中"兴趣 ↔ 排除"的映射冲突（如 兴趣"登山"与排除"爬山"都映射到"徒步登山"）
  function detectConflicts(profile) {
    var conflicts = [];
    var interests = listOf(profile.interests);
    var excludes = listOf(profile.excludes);
    interests.forEach(function (interest) {
      var iAliases = [interest].concat(SYNONYMS[interest] || []);
      excludes.forEach(function (exclude) {
        var eAliases = [exclude].concat(SYNONYMS[exclude] || []);
        var shared = [];
        iAliases.forEach(function (ia) {
          eAliases.forEach(function (ea) {
            if (ia && ea && (ia === ea || (ia.length >= 2 && ea.length >= 2 && (ia.includes(ea) || ea.includes(ia))))) {
              if (shared.indexOf(ia) < 0) shared.push(ia);
            }
          });
        });
        if (shared.length) {
          conflicts.push({ interest: interest, exclude: exclude, sharedTags: shared });
        }
      });
    });
    return conflicts;
  }

  // 景点是否被排除项命中（硬剔除）
  function isExcluded(spot, excludes) {
    if (!Array.isArray(excludes) || excludes.length === 0) return false;
    return excludes.some(function (ex) {
      var r = matchWord(spot, ex);
      if (r.matched) return true;
      // 新表有部分景点只在限制提醒中明确写“登山需体力”，不可漏过排除项。
      // 只识别明确活动用语，不从景点名称里的“山”推断登山。
      return (ex === "爬山" || ex === "登山") &&
        /登山需体力|山路较多|爬起来/.test(spot.caution || "");
    });
  }

  // 画像驱动的单景点匹配（排除优先；属性比较只依据 known=true）
  function matchByProfile(profile, spot, attrs) {
    var result = {
      spot: spot,
      excluded: false,
      matched: [],
      unconfirmed: [],
      mismatched: [],
      score: 0
    };

    // 1) 排除优先
    var excludes = listOf(profile.excludes);
    if (isExcluded(spot, excludes)) {
      result.excluded = true;
      return result;
    }

    // 2) 内容兴趣
    listOf(profile.interests).forEach(function (word) {
      var r = matchWord(spot, word);
      if (r.matched) {
        result.matched.push({
          dim: "interests",
          label: "内容兴趣·" + word,
          evidence: "命中标签：" + r.hitTags.map(function (t) { return "「" + t + "」"; }).join("、")
        });
      } else {
        result.unconfirmed.push({
          dim: "interests",
          note: "内容兴趣·" + word + "：景点标签中没有相关内容"
        });
      }
    });

    // 3) 环境偏好
    var env = profile.environment && profile.environment.value;
    if (env && !isUnset(env)) {
      var r = matchWord(spot, env);
      if (r.matched) {
        result.matched.push({
          dim: "environment",
          label: "环境偏好·" + env,
          evidence: "命中标签：" + r.hitTags.map(function (t) { return "「" + t + "」"; }).join("、")
        });
      } else {
        result.unconfirmed.push({
          dim: "environment",
          note: "环境偏好·" + env + "：景点标签中没有体现该环境"
        });
      }
    }

    // 4) 体力 / 节奏 / 同行：只比较资料有明确证据的属性
    var attrsById = attrs && attrs[spot.id];
    compareDim(result, "stamina", "体力接受度", profile.stamina && profile.stamina.value, attrsById && attrsById.stamina, function (u, s) {
      var levels = { "低": 1, "中": 2, "高": 3 };
      return levels[u] && levels[s] ? levels[u] >= levels[s] : u === s;
    });
    compareDim(result, "pace", "行程节奏", profile.pace && profile.pace.value, attrsById && attrsById.pace, function (u, s) { return u === s; });

    var companion = profile.companion && profile.companion.value;
    if (companion && !isUnset(companion)) {
      var ca = attrsById && attrsById.companion;
      if (!ca || !ca.known || ca.soft || !ca.evidence) {
        result.unconfirmed.push({
          dim: "companion",
          note: "同行偏好·" + companion + "：景点资料未说明适宜人群，无法判断"
        });
      } else if (Array.isArray(ca.value) && ca.value.indexOf(companion) >= 0) {
        result.matched.push({
          dim: "companion",
          label: "同行偏好·" + companion,
          evidence: ca.evidence
        });
      } else {
        result.unconfirmed.push({
          dim: "companion",
          note: "同行偏好·" + companion + "：现有资料未确认该同行方式；提到其他人群不代表不适合你"
        });
      }
    }

    result.score = result.matched.length;
    return result;
  }

  function compareDim(result, dim, label, userValue, spotAttr, pred) {
    if (!userValue || isUnset(userValue)) return;
    if (!spotAttr || !spotAttr.known || spotAttr.soft || !spotAttr.evidence) {
      result.unconfirmed.push({
        dim: dim,
        note: label + "：景点资料未说明，无法判断是否符合你的" + userValue + "需求"
      });
      return;
    }
    if (pred(userValue, spotAttr.value)) {
      result.matched.push({
        dim: dim,
        label: label + "·" + userValue,
        evidence: spotAttr.evidence
      });
    } else {
      result.mismatched.push({
        dim: dim,
        note: label + "：你偏好「" + userValue + "」，景点资料标注为「" + spotAttr.value + "」"
      });
    }
  }

  // 批量匹配：城市过滤 → 排除剔除 → 至少一项符合 → 排序 → 取前 N
  function matchAll(profile, spots, attrs, city, limit) {
    if (detectConflicts(profile).length) return [];
    var pool = spots;
    if (city) pool = pool.filter(function (s) { return s.city === city; });
    var results = pool.map(function (s) { return matchByProfile(profile, s, attrs); });
    results = results.filter(function (r) { return !r.excluded && r.score > 0; });
    results.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.mismatched.length - b.mismatched.length;
    });
    return results.slice(0, limit || 3);
  }

  // ---------------- 工具 ----------------
  function isUnset(value) {
    if (Array.isArray(value)) return value.length === 0;
    return !value || String(value).trim() === "" || String(value).trim() === "未说明";
  }
  function listOf(item) {
    if (!item) return [];
    var v = item.value;
    if (Array.isArray(v)) return v.filter(function (x) { return typeof x === "string" && !isUnset(x); });
    if (v && !isUnset(v)) return [v];
    return [];
  }

  global.Matcher = {
    SYNONYMS: SYNONYMS,
    tagHit: tagHit,
    matchWord: matchWord,
    detectConflicts: detectConflicts,
    isExcluded: isExcluded,
    matchByProfile: matchByProfile,
    matchAll: matchAll,
    isUnset: isUnset
  };
  if (typeof module !== "undefined" && module.exports) module.exports = global.Matcher;
})(typeof window !== "undefined" ? window : globalThis);
