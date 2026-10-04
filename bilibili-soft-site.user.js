// ==UserScript==
// @name         B站全站柔和显示 - OLED 深色模式文字与图片亮度调节
// @namespace    local.bilibili.soft-comments
// @version      2.2.0
// @description  配合哔哩哔哩 bilibili 深色模式，调暗标题、评论、推荐列表等亮白文字和常见图标；独立调整表情、封面、头像亮度，保留视频画面，适合 OLED 屏幕。
// @homepageURL  https://github.com/lzy187/bilibili-soft-site
// @supportURL   https://github.com/lzy187/bilibili-soft-site/issues
// @updateURL    https://raw.githubusercontent.com/lzy187/bilibili-soft-site/main/bilibili-soft-site.user.js
// @downloadURL  https://raw.githubusercontent.com/lzy187/bilibili-soft-site/main/bilibili-soft-site.user.js
// @match        https://*.bilibili.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(() => {
  'use strict';
  // 在旧脚本编辑器中全选替换即可升级。请勿与旧版同时启用。
  // 视频/Canvas画面、封闭Shadow DOM和跨域iframe不处理。
  // 为深色模式设计，切到浅色模式时请在菜单中关闭。
  const presets = { '稍柔和': '#bec2c8', '柔和（默认）': '#a8adb4', '更暗': '#9298a0' };
  const validColor = c => typeof c === 'string' && /^#[\da-f]{6}$/i.test(c);
  const old = GM_getValue('palette', {});
  let color = validColor(old?.text) ? old.text : presets['柔和（默认）'];
  let enabled = GM_getValue('enabled', true) !== false;
  const numberSetting = (key, fallback) => {
    const value = GM_getValue(key, fallback);
    return Number.isFinite(value) && value >= 40 && value <= 100 ? value : fallback;
  };
  let emojiBrightness = numberSetting('emojiBrightness', 75);
  let imageBrightness = numberSetting('imageBrightness', 85);
  const sheets = new Map();
  const attrs = ['data-bs2-color', 'data-bs2-fill', 'data-bs2-stroke',
    'data-bs2-before', 'data-bs2-after', 'data-bs2-image'];
  const originals = new WeakMap();
  const processed = new WeakSet();
  const ownStyles = new WeakMap();
  const observers = new Map();
  const dirty = new Map();
  let activeJob = null;
  let workTimer = null;
  let discoveryTimer = null;
  // 播放器的弹幕、字幕、控制栏、进度和鼠标隐藏状态都由网站管理。
  const playerSelector = '#bilibili-player, .bpx-player-container, .bilibili-player, '
    + '#live-player, #live-player-ctnr, .bili-danmaku-x-dm, .b-danmaku';
  const skip = new Set(['script', 'style', 'link', 'meta', 'noscript', 'template',
    'video', 'audio', 'canvas', 'iframe', 'source', 'track']);
  const shapes = new Set(['svg', 'g', 'path', 'use', 'rect', 'circle', 'ellipse',
    'line', 'polygon', 'polyline', 'text']);
  let css = '';
  let ceiling = 180;

  function excluded(element) {
    // closest不会跨Shadow Root，逐层检查宿主，连播放器内的自定义组件也排除。
    for (let node = element; node; node = node.getRootNode().host) {
      if (node.closest(playerSelector)) return true;
    }
    return false;
  }

  function styleSignature(element) {
    // 位置、transform、光标、宽高等动画属性与本脚本无关。
    const style = element.style;
    if (!style) return '';
    const properties = ['color', 'fill', 'stroke', 'filter', '-webkit-text-fill-color'];
    for (const name of style) {
      if (name.startsWith('--') && name !== '--bs2-original-filter') properties.push(name);
    }
    return properties.map(name => `${name}:${style.getPropertyValue(name)}!${style.getPropertyPriority(name)}`).join(';');
  }

  function makeCSS() {
    ceiling = Math.max(...color.slice(1).match(/../g).map(v => parseInt(v, 16)));
    css = `
      [data-bs2-measuring], [data-bs2-measuring]::before, [data-bs2-measuring]::after {
        transition: none !important;
      }
    ` + (!enabled ? '' : `
      [data-bs2-color] { color: ${color} !important; }
      [data-bs2-fill] { fill: ${color} !important; }
      [data-bs2-stroke] { stroke: ${color} !important; }
      [data-bs2-before]::before { color: ${color} !important; }
      [data-bs2-after]::after { color: ${color} !important; }
      img[data-bs2-image="emoji"] {
        filter: var(--bs2-original-filter, brightness(1)) brightness(${emojiBrightness / 100}) !important;
      }
      img[data-bs2-image="image"] {
        filter: var(--bs2-original-filter, brightness(1)) brightness(${imageBrightness / 100}) !important;
      }
    `);
  }

  function ensureSheet(root) {
    let sheet = sheets.get(root);
    if (!sheet) {
      sheet = document.createElement('style');
      sheet.dataset.bs2Sheet = '';
      sheets.set(root, sheet);
    }
    const parent = root === document ? document.head || document.documentElement : root;
    if (parent && sheet.parentNode !== parent) parent.appendChild(sheet);
    if (sheet.textContent !== css) sheet.textContent = css;
    observeRoot(root);
  }

  // 只监听网站会修改的属性；不监听本脚本自己的data标记。
  function observeRoot(root) {
    if (!enabled || document.hidden || observers.has(root)) return;
    const observer = new MutationObserver(records => {
      if (!enabled || document.hidden) return;
      const seen = new Set();
      for (const record of records) {
        const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (!target || excluded(target) || skip.has(target.localName)) continue;
        if (record.type === 'attributes') {
          if (seen.has(target)) continue;
          if (record.attributeName === 'style' && ownStyles.get(target) === styleSignature(target)) continue;
          seen.add(target);
          markDirty(target);
        } else if (record.type === 'characterData') {
          markDirty(target);
        } else {
          for (const node of record.addedNodes) {
            if (node.nodeType === 1 && !node.matches('style[data-bs2-sheet]')) markDirty(node);
            else if (node.nodeType === 3) markDirty(target);
          }
          for (const node of record.removedNodes) {
            if (node.nodeType === 1 && node.matches('style[data-bs2-sheet]')) ensureSheet(root);
          }
        }
      }
    });
    observer.observe(root, {subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['class', 'style', 'fill', 'stroke', 'color', 'src']});
    observers.set(root, observer);
  }

  function markDirty(element, force = true) {
    if (!enabled || document.hidden || !element || element.nodeType !== 1
      || skip.has(element.localName) || excluded(element)) return;
    // 只沿祖先链去重，不再对同批节点做两两contains比较。
    for (let parent = composedParent(element); parent; parent = composedParent(parent)) {
      if (dirty.has(parent) && (dirty.get(parent) || !force)) return;
    }
    dirty.set(element, force || dirty.get(element) || false);
    // 限制突发更新积压，合并为一次可分片的全页遍历。
    if (dirty.size > 128) {
      dirty.clear();
      dirty.set(document.documentElement, true);
    }
    if (workTimer === null) workTimer = setTimeout(drain, 16);
  }

  function* walkElements(element) {
    // 链式遍历，不提前querySelectorAll全页；播放器子树在入口直接剪枝。
    const stack = [{element, siblings: false}];
    ensureSheet(element.getRootNode());
    while (stack.length) {
      const entry = stack.pop();
      const node = entry.element;
      if (entry.siblings && node.nextElementSibling) stack.push({element: node.nextElementSibling, siblings: true});
      if (!node.isConnected || skip.has(node.localName) || excluded(node)) continue;
      if (node.firstElementChild) stack.push({element: node.firstElementChild, siblings: true});
      if (node.shadowRoot) {
        ensureSheet(node.shadowRoot);
        if (node.shadowRoot.firstElementChild) stack.push({element: node.shadowRoot.firstElementChild, siblings: true});
      }
      yield node;
    }
  }

  function drain() {
    workTimer = null;
    if (!enabled || document.hidden) return;
    const deadline = performance.now() + 5;
    let count = 0;
    do {
      if (!activeJob) {
        const next = dirty.entries().next();
        if (next.done) break;
        const [element, force] = next.value;
        dirty.delete(element);
        activeJob = {iterator: walkElements(element), force};
      }
      const next = activeJob.iterator.next();
      if (next.done) activeJob = null;
      else { processElement(next.value, activeJob.force); count++; }
    } while (count < 80 && performance.now() < deadline);
    if (activeJob || dirty.size) workTimer = setTimeout(drain, 16);
  }

  function stopWork() {
    clearTimeout(workTimer); workTimer = null;
    clearTimeout(discoveryTimer); discoveryTimer = null;
    dirty.clear(); activeJob = null;
    for (const observer of observers.values()) observer.disconnect();
    observers.clear();
  }

  // 只选择明亮且接近中性的颜色。保留深灰字、蓝色链接和其他饱和色。
  function isBrightNeutral(value) {
    const match = value.match(/^rgba?\(([^)]+)\)$/);
    if (!match) return false;
    const values = match[1].match(/[\d.]+/g)?.map(Number);
    if (!values || values.length < 3 || (values.length > 3 && values[3] < 0.5)) return false;
    const rgb = values.slice(0, 3);
    return Math.min(...rgb) > ceiling && Math.max(...rgb) - Math.min(...rgb) <= 35;
  }

  function restoreFilterVariable(element) {
    const original = originals.get(element);
    if (!original) return;
    if (original.value) element.style.setProperty('--bs2-original-filter', original.value, original.priority);
    else element.style.removeProperty('--bs2-original-filter');
    originals.delete(element);
  }

  function composedParent(element) {
    return element.parentElement || element.getRootNode().host || null;
  }

  function isEmoji(element) {
    const hint = `${element.className} ${element.getAttribute('src') || ''}`;
    if (/emoji|emote|emoticon/i.test(hint)) return true;
    let ancestor = composedParent(element);
    for (let depth = 0; ancestor && depth < 8; depth++, ancestor = composedParent(ancestor)) {
      if (ancestor.localName === 'bili-rich-text') return true;
      if (ancestor.matches('.reply-content, .sub-reply-content, .emoji, .emote')) return true;
    }
    return false;
  }

  function processElement(element, force = false) {
    if (!element.isConnected || skip.has(element.localName) || excluded(element)) return;
    if (element.closest('defs, mask, clipPath, filter')) return;
    // 周期巡检只发现新节点，不再周期性撤销已经生效的颜色。
    if (!force && processed.has(element)) return;
    processed.add(element);
    ownStyles.set(element, styleSignature(element));
    const isImage = element.localName === 'img';
    const isShape = shapes.has(element.localName);
    const hasText = [...element.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    const isControl = element.matches('input, textarea, select, button');
    const isIcon = /icon/i.test(element.getAttribute('class') || '') || element.localName === 'i';
    const wasMarked = attrs.some(attr => element.hasAttribute(attr));
    if (!isImage && !isShape && !hasText && !isControl && !isIcon && !wasMarked) return;
    // 真实样式变更才重新分类。同一任务内暂停过渡、测量、恢复覆盖，
    // 防止getComputedStyle读取到动画中间色。浏览器绘制前完成整个事务。
    const transitionValue = element.style.getPropertyValue('transition-property');
    const transitionPriority = element.style.getPropertyPriority('transition-property');
    element.setAttribute('data-bs2-measuring', '');
    element.style.setProperty('transition-property', 'none', 'important');
    try {
    for (const attr of attrs) if (element.hasAttribute(attr)) element.removeAttribute(attr);
    if (!enabled) { restoreFilterVariable(element); return; }
    const computed = getComputedStyle(element);
    const softenColor = isBrightNeutral(computed.color);
    const softenFill = isShape && isBrightNeutral(computed.fill);
    const softenStroke = isShape && isBrightNeutral(computed.stroke);
    const baseFilter = isImage ? computed.filter : 'none';
    if (softenColor) element.setAttribute('data-bs2-color', '');
    if (softenFill) element.setAttribute('data-bs2-fill', '');
    if (softenStroke) element.setAttribute('data-bs2-stroke', '');
    if (isIcon) {
      for (const pseudo of ['before', 'after']) {
        const pseudoStyle = getComputedStyle(element, `::${pseudo}`);
        if (pseudoStyle.content !== 'none' && pseudoStyle.content !== 'normal' && isBrightNeutral(pseudoStyle.color)) {
          element.setAttribute(`data-bs2-${pseudo}`, '');
        }
      }
    }
    if (isImage) {
      const kind = isEmoji(element) ? 'emoji' : 'image';
      if ((kind === 'emoji' ? emojiBrightness : imageBrightness) === 100) {
        restoreFilterVariable(element);
        return;
      }
      if (!originals.has(element)) originals.set(element, {
        value: element.style.getPropertyValue('--bs2-original-filter'),
        priority: element.style.getPropertyPriority('--bs2-original-filter'),
      });
      element.style.setProperty('--bs2-original-filter', baseFilter === 'none' ? 'brightness(1)' : baseFilter);
      element.setAttribute('data-bs2-image', kind);
    }
    } finally {
      // 提交最终颜色，随后恢复网站原有过渡设置。
      getComputedStyle(element).color;
      if (isIcon) {
        getComputedStyle(element, '::before').color;
        getComputedStyle(element, '::after').color;
      }
      if (transitionValue) element.style.setProperty('transition-property', transitionValue, transitionPriority);
      else element.style.removeProperty('transition-property');
      element.removeAttribute('data-bs2-measuring');
      ownStyles.set(element, styleSignature(element));
    }
  }

  function startScan(force = false) {
    clearTimeout(discoveryTimer);
    if (!enabled || document.hidden) return;
    for (const [root] of sheets) if (root !== document && !root.host.isConnected) {
      sheets.delete(root); observers.get(root)?.disconnect(); observers.delete(root);
    }
    markDirty(document.documentElement, force);
    // 仅兜底发现延迟attachShadow的组件，已处理节点不重复测色。
    discoveryTimer = setTimeout(startScan, 15000);
  }

  function update() {
    GM_setValue('palette', { text: color });
    GM_setValue('enabled', enabled);
    GM_setValue('emojiBrightness', emojiBrightness);
    GM_setValue('imageBrightness', imageBrightness);
    stopWork();
    makeCSS();
    for (const root of sheets.keys()) ensureSheet(root);
    startScan(true);
  }

  for (const [name, value] of Object.entries(presets)) {
    GM_registerMenuCommand(`全站文字／图标：${name}`, () => { color = value; enabled = true; update(); });
  }
  GM_registerMenuCommand('全站文字／图标：自定义颜色', () => {
    const input = prompt('输入灰色或略带色调的6位颜色，例如 #a8adb4。', color);
    if (input === null) return;
    if (!validColor(input.trim())) { alert('格式示例：#a8adb4'); return; }
    color = input.trim(); enabled = true; update();
  });
  function askBrightness(kind) {
    const current = kind === 'emoji' ? emojiBrightness : imageBrightness;
    const input = prompt(`${kind === 'emoji' ? '表情／评论内图片' : '封面／头像等普通图片'}亮度：40～100；100表示关闭调暗。`, String(current));
    if (input === null) return;
    const value = Number(input.trim());
    if (!input.trim() || !Number.isFinite(value) || value < 40 || value > 100) {
      alert('请输入40～100之间的数字。'); return;
    }
    if (kind === 'emoji') emojiBrightness = value; else imageBrightness = value;
    update();
  }
  GM_registerMenuCommand('表情／评论内图片：设置亮度（100为关闭）', () => askBrightness('emoji'));
  GM_registerMenuCommand('封面／头像等图片：设置亮度（100为关闭）', () => askBrightness('image'));
  GM_registerMenuCommand('全站柔和显示：开启／关闭', () => {
    enabled = !enabled; update(); alert(`全站柔和显示已${enabled ? '开启' : '关闭'}。`);
  });
  makeCSS();
  startScan();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopWork();
    else startScan(true);
  });
})();
