/*!
 * asuka-kb-search.js — 飛鳥客服知識庫搜尋模組（給 Mina 客服看板用）
 * 資料來源：https://victortseng-svg.github.io/asuka-support/kb.json（每日自動更新）
 *           https://victortseng-svg.github.io/asuka-support/sections.json（客服平台全文）
 * 相依：Fuse.js 7.x
 */
(function (global) {
  'use strict';

  var DEFAULT_KB_URL  = 'https://victortseng-svg.github.io/asuka-support/kb.json';
  var DEFAULT_SEC_URL = 'https://victortseng-svg.github.io/asuka-support/sections.json';
  var ASSISTANT_URL   = 'https://victortseng-svg.github.io/asuka-support/asuka-support-chat.html';

  /* 可信度門檻。實測 2026-10-28（KB 647 筆）：
     有效查詢 top1 分數 0~0.665；亂打字／問天氣／訂披薩 0.734~0.891。取 0.70 零誤判。 */
  var DEFAULT_CONFIDENCE = 0.70;
  /* 平台全文另一套門檻。Fuse threshold 只控制比對容忍度，score 仍可能超過它。
     實測：字串真的在內文 0.033~0.139；不在的(W205) 0.571。取 0.35 零誤判。 */
  var SECTION_CONFIDENCE = 0.35;

  var state = { data:null, fuse:null, secFuse:null, carRe:null,
                confidence:DEFAULT_CONFIDENCE, loadedAt:null };

  function assertFuse() {
    if (typeof global.Fuse === 'undefined') throw new Error('[AsukaKB] 需要先載入 Fuse.js 7.x');
  }

  async function init(opts) {
    opts = opts || {};
    assertFuse();
    if (typeof opts.confidence === 'number') state.confidence = opts.confidence;

    var url = opts.kbUrl || DEFAULT_KB_URL;
    if (opts.noCache) url += (url.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now();
    var res = await fetch(url);
    if (!res.ok) throw new Error('[AsukaKB] 讀取 kb.json 失敗：HTTP ' + res.status);
    var data = await res.json();

    var f = data.fuse || {};
    state.data = data;
    state.fuse = new global.Fuse(data.kb, {
      keys: f.keys || [{name:'title',weight:0.4},{name:'keywords',weight:0.4},{name:'desc',weight:0.2}],
      threshold: f.threshold != null ? f.threshold : 0.87,
      ignoreLocation: f.ignoreLocation !== false,
      minMatchCharLength: f.minMatchCharLength || 2,
      includeScore: true
    });
    state.carRe = new RegExp(data.carQuery && data.carQuery.pattern ? data.carQuery.pattern : '可以裝|裝嗎|能裝');

    var sections = data.sections && data.sections.length ? data.sections : null;
    if (!sections && opts.sections !== false) {
      try {
        var su = opts.sectionsUrl || DEFAULT_SEC_URL;
        if (opts.noCache) su += (su.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now();
        var sr = await fetch(su);
        if (sr.ok) sections = await sr.json();
      } catch (e) { /* 沒有就算了，不影響主要功能 */ }
    }
    if (sections && sections.length) {
      state.data.sections = sections;
      state.secFuse = new global.Fuse(sections, {
        keys: [{name:'title',weight:0.3},{name:'text',weight:0.7}],
        threshold: 0.4, ignoreLocation: true, minMatchCharLength: 2, includeScore: true
      });
    }
    state.loadedAt = new Date();
    return { kb:data.counts.kb, brands:data.counts.brands,
             sections: sections ? sections.length : 0, generatedAt:data.generatedAt };
  }

  function detectBrand(query) {
    if (!state.data) return null;
    var s = String(query).toLowerCase(), brands = state.data.brands;
    for (var key in brands) {
      if (!Object.prototype.hasOwnProperty.call(brands, key)) continue;
      var b = brands[key], al = b.aliases || [];
      for (var i = 0; i < al.length; i++) {
        if (s.indexOf(String(al[i]).toLowerCase()) >= 0) return Object.assign({key:key}, b);
      }
    }
    return null;
  }

  function anchorUrl(a) {
    var base = state.data.carQuery && state.data.carQuery.basePage ? state.data.carQuery.basePage : '';
    return a ? base + '#' + a : null;
  }

  function buildCarLinks(b) {
    var L = [];
    if (!b) return L;
    if (b.anchor_a) L.push({label:'飛鳥資料庫 — ' + b.name, url:anchorUrl(b.anchor_a)});
    if (b.anchor_q) L.push({label:'琦森對話記錄 — ' + b.name, url:anchorUrl(b.anchor_q)});
    if (b.page)     L.push({label:b.name + ' 品牌專頁', url:b.page});
    return L;
  }

  function mentionsBrand(text, brand) {
    var s = String(text).toLowerCase(), al = brand.aliases || [];
    for (var i = 0; i < al.length; i++) if (s.indexOf(String(al[i]).toLowerCase()) >= 0) return true;
    return false;
  }
  function isCrossBrand(card, brand) {
    if (!brand) return false;
    if (mentionsBrand(card.title + ' ' + card.keywords + ' ' + card.desc, brand)) return false;
    return state.carRe.test(card.title);
  }

  function snippet(text, query, len) {
    len = len || 160;
    if (!text) return '';
    var pos = text.indexOf(query);
    if (pos < 0) return text.slice(0, len).trim();
    var from = Math.max(0, pos - 40);
    return (from > 0 ? '…' : '') + text.slice(from, from + len).trim() + '…';
  }

  function buildDraft(query, brand, links, cards, low) {
    var L = [];
    if (!brand && low) {
      return '知識庫查不到與「' + query + '」明確對應的資料。\n'
           + '下方列出的條目相關度偏低，請先確認是否適用，不要直接回覆客戶。\n'
           + '建議改請客戶補充：車款、年份、主機型號、問題發生的情境。';
    }
    if (brand && links.length) {
      L.push('您好，關於「' + brand.name + '」的主機升級與相容性，可以參考以下資料：');
      links.forEach(function (l) { L.push('• ' + l.label + '：' + l.url); });
      L.push('');
      L.push('若要進一步確認，再麻煩提供車輛年份、以及是否有原廠環景或擴大機，我們再幫您確認，謝謝。');
      return L.join('\n');
    }
    var usable = cards.filter(function (c) { return c.relevant; });
    var withText = usable.filter(function (c) { return c.desc; });
    if (withText.length) {
      var top = withText[0];
      L.push('您好，關於「' + query + '」：'); L.push(''); L.push(top.desc);
      if (top.url) { L.push(''); L.push('完整說明請參考：' + top.url); }
      if (withText[1]) { L.push(''); L.push('（另外這筆資料可能也相關：' + withText[1].title + (withText[1].url ? ' ' + withText[1].url : '') + '）'); }
      L.push(''); L.push('若還有其他狀況再回覆我們，謝謝。');
      return L.join('\n');
    }
    if (usable.length) {
      L.push('您好，關於「' + query + '」，請參考以下說明頁面：');
      usable.forEach(function (c) { if (c.url) L.push('• ' + c.title + '：' + c.url); });
      L.push(''); L.push('若頁面未自動定位，可按 Ctrl+F 搜尋標題。有其他問題再回覆我們，謝謝。');
      return L.join('\n');
    }
    return '知識庫目前查不到「' + query + '」的對應資料，建議轉由技術人員確認，或補充車款、年份、主機型號後再查一次。';
  }

  function buildContext(query, brand, links, cards, sections, low) {
    var L = ['【客服問題】' + query, ''];
    if (low && !brand) {
      L.push('【警告】以下資料與問題的相關度偏低，很可能不是正確答案。');
      L.push('若無法從資料中找到確切答案，請直接說明知識庫查無資料、並列出需要客戶補充的資訊，不要勉強作答。');
      L.push('');
    }
    if (brand) {
      L.push('【車款查詢命中】' + brand.name);
      links.forEach(function (l) { L.push('- ' + l.label + '：' + l.url); });
      L.push('');
    }
    var usable = cards.filter(function (c) { return c.relevant; });
    if (usable.length) {
      L.push('【知識庫相關條目】');
      usable.forEach(function (c, i) {
        L.push((i + 1) + '. ' + c.title);
        if (c.desc) L.push('   內容：' + c.desc);
        if (c.url)  L.push('   連結：' + c.url);
      });
      L.push('');
    }
    if (sections && sections.length) {
      L.push('【客服平台頁面段落】');
      sections.forEach(function (s, i) {
        L.push((i + 1) + '. ' + s.title + '：' + s.snippet);
        if (s.url) L.push('   連結：' + s.url);
      });
      L.push('');
    }
    L.push('【撰寫原則】只根據上面列出的資料回答；資料沒寫到的不要臆測，改請客戶補充車款年份與配備。');
    return L.join('\n');
  }

  function search(query, opts) {
    if (!state.data) throw new Error('[AsukaKB] 請先 await AsukaKB.init()');
    opts = opts || {};
    var limit = opts.limit || 5;
    var secLimit = opts.sectionLimit != null ? opts.sectionLimit : 3;
    var q = String(query || '').trim();
    if (!q) return { query:q, brand:null, links:[], cards:[], sections:[],
                     lowConfidence:true, draft:'', context:'', assistantUrl:ASSISTANT_URL };

    var brand = state.carRe.test(q) ? detectBrand(q) : null;
    var links = buildCarLinks(brand);

    var cards = state.fuse.search(q, {limit:limit}).map(function (r) {
      var c = { title:r.item.title, desc:r.item.desc || '', url:r.item.url || '',
                keywords:r.item.keywords || '', score:r.score };
      c.crossBrand = isCrossBrand(c, brand);
      c.relevant = (r.score <= state.confidence) && !c.crossBrand;
      return c;
    });
    var low = !cards.some(function (c) { return c.relevant; });

    var sections = [];
    if (state.secFuse && secLimit > 0) {
      sections = state.secFuse.search(q, {limit:secLimit})
        .filter(function (r) { return r.score <= SECTION_CONFIDENCE; })
        .map(function (r) {
          return { title:r.item.title, anchor:r.item.anchor, url:anchorUrl(r.item.anchor),
                   snippet:snippet(r.item.text, q), score:r.score };
        });
    }

    return { query:q, brand:brand, links:links, cards:cards, sections:sections,
             lowConfidence:low,
             draft:buildDraft(q, brand, links, cards, low),
             context:buildContext(q, brand, links, cards, sections, low),
             assistantUrl:ASSISTANT_URL, generatedAt:state.data.generatedAt };
  }

  function info() {
    return state.data ? { counts:state.data.counts, generatedAt:state.data.generatedAt,
                          loadedAt:state.loadedAt } : null;
  }

  global.AsukaKB = { init:init, search:search, detectBrand:detectBrand, info:info };

})(typeof window !== 'undefined' ? window : globalThis);
