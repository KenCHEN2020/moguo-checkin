/*
 * Supabase 数据层（PostgREST 直连 + 多通道自动切换）
 *
 * 为什么要多通道：
 *   实测部分国内网络到 supabase.co 背后的 Cloudflare IP 连接会被重置或极慢
 *   （同一台电脑上首次握手要 12 秒，连接复用后只要 0.14 秒；个别设备直接失败）。
 *   表现就是页面能打开、但数据一直转圈，最后报「读取失败：网络连接失败，请重试」。
 *   这里允许配置多个 API 入口（国内中继 + 直连兜底），
 *   某个通道连不上时立刻换下一个，并把「上次成功」的通道记在本地，下次优先使用。
 *
 * 两种请求模式：
 *   json   —— 直连 PostgREST：带 apikey/Authorization 头，浏览器会先发 CORS 预检。
 *   simple —— 中继通道：apikey 放 query，写操作 body 用 form-urlencoded。
 *             这两个都属于 CORS「简单请求」，浏览器完全不发起预检，
 *             在预检被干扰的网络上也能一次打通（实测还快 0.2 秒）。
 *
 * 通道字段：
 *   url         API 入口
 *   mode        'json' | 'simple'
 *   returnsRows 服务端是否返回受影响的行（中继会补 Prefer 头，故为 true）
 *
 * 对外接口保持不变：
 *   db.from('members').select('*').order('id',{ascending:true})
 *   db.from('checkins').select('*').eq('day','2026-11-17').maybeSingle()
 *   db.from('members').insert(row).select()
 *   db.from('members').update({name:'x'}).eq('id',1).select()
 *   db.from('members').delete().eq('id',1).select()
 * 返回 { data } 或 { error: { message } }，与页面里的 q() 兼容。
 */
(function(){
  var CHANNELS = [];        // [{url, mode, returnsRows}]
  var KEY = '';
  var TIMEOUT = 20000;      // 单次请求超时（跨境握手慢，放宽）
  var RETRY = 2;            // 读请求最多重试 2 次（共 3 次尝试）
  var LAST_OK_KEY = 'moguo_api_last_ok';

  function hostOf(base){
    try { return new URL(base).host; } catch(e){ return base; }
  }
  function baseOf(base){ return String(base).replace(/\/+$/, ''); }

  function toFilter(f){
    var v = String(f[1]);
    switch(f[2]){
      case 'lt': return f[0] + '=lt.' + encodeURIComponent(v);
      case 'lte': return f[0] + '=lte.' + encodeURIComponent(v);
      case 'gt': return f[0] + '=gt.' + encodeURIComponent(v);
      default: return f[0] + '=eq.' + encodeURIComponent(v);
    }
  }

  function buildQuery(query, simple){
    var q = (query || []).slice();
    if(simple) q.push('apikey=' + encodeURIComponent(KEY));
    return q;
  }

  function buildHeaders(ch, prefer){
    // simple 模式：只用 CORS 简单请求头，不带 apikey/Authorization，
    // 浏览器完全不发起预检。实测比带头请求更快，且在预检被干扰的网络上唯一能打通。
    if(ch.mode === 'simple'){
      var h = {};
      if(prefer) h['Content-Type'] = 'application/x-www-form-urlencoded';
      return h;
    }
    var headers = {
      'apikey': KEY,
      'Authorization': 'Bearer ' + KEY,
      'Content-Type': 'application/json'
    };
    if(prefer) headers['Prefer'] = prefer;
    return headers;
  }

  // simple 模式：body 用 form-urlencoded 编码，保证字段正确送达
  function encodeBody(mode, body){
    if(body == null) return null;
    if(mode !== 'simple') return JSON.stringify(body);
    var p = new URLSearchParams();
    Object.keys(body).forEach(function(k){
      var v = body[k];
      if(v === undefined || v === null) return;
      p.append(k, String(v));
    });
    return p.toString();
  }

  function request(method, path, query, body, prefer, tries, ci){
    var left = (tries == null) ? RETRY : tries;
    var idx = ci || 0;
    var ch = CHANNELS[idx];
    var simple = ch.mode === 'simple';
    var base = baseOf(ch.url);
    var qs = buildQuery(query, simple);
    var url = base + '/rest/v1/' + path + (qs.length ? '?' + qs.join('&') : '');
    var headers = buildHeaders(ch, prefer);
    var payload = encodeBody(ch.mode, body);
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function(){ ctrl.abort(); }, TIMEOUT) : null;
    var t0 = Date.now();
    return fetch(url, {
      method: method,
      headers: headers,
      body: payload == null ? undefined : payload,
      signal: ctrl ? ctrl.signal : undefined
    }).then(function(res){
      if(timer) clearTimeout(timer);
      return res.text().then(function(text){
        var json = null;
        try { json = text ? JSON.parse(text) : null; } catch(e){}
        if(!res.ok){
          var msg = (json && (json.message || json.hint || json.details)) || ('请求失败 ' + res.status);
          // 4xx 是业务错误（如唯一键冲突），直接返回，不重试也不换通道，避免重复登记
          if(res.status < 500){
            return { error: { message: msg } };
          }
          // 5xx 视为通道故障：立刻换下一个通道
          if(idx + 1 < CHANNELS.length){
            return request(method, path, query, body, prefer, method === 'GET' ? left : 0, idx + 1);
          }
          if(method === 'GET' && left > 0){
            return request(method, path, query, body, prefer, left - 1, idx);
          }
          return { error: { message: msg } };
        }
        markOk(idx);
        // 中继通道返回 {rows:[...]}，直连返回数组
        if(json && !Array.isArray(json) && Array.isArray(json.rows)) json = json.rows;
        return { data: json, returnsRows: ch.returnsRows };
      });
    }, function(e){
      if(timer) clearTimeout(timer);
      var isTimeout = e && e.name === 'AbortError';
      var msg = isTimeout ? '连接超时' : '网络连接被中断';
      // 连接被中断/超时：立刻换下一个通道，不在坏通道上反复等待
      if(idx + 1 < CHANNELS.length){
        return request(method, path, query, body, prefer, method === 'GET' ? left : 0, idx + 1);
      }
      // 已经是最后一个通道：读请求再重试一次
      if(method === 'GET' && left > 0){
        return request(method, path, query, body, prefer, left - 1, idx);
      }
      return { error: {
        message: msg + '（已尝试 ' + CHANNELS.length + ' 个通道）',
        channel: hostOf(base),
        ms: Date.now() - t0
      } };
    });
  }

  function markOk(idx){
    try { localStorage.setItem(LAST_OK_KEY, String(idx)); } catch(e){}
  }

  function Builder(table){
    this.table = table;
    this.action = 'select';
    this.filters = [];
    this.sortBy = null;
    this.single = false;
    this.values = null;
  }
  Builder.prototype.select = function(){ return this; };
  Builder.prototype.eq = function(col, val){ this.filters.push([col, val, 'eq']); return this; };
  Builder.prototype.lt = function(col, val){ this.filters.push([col, val, 'lt']); return this; };
  Builder.prototype.gt = function(col, val){ this.filters.push([col, val, 'gt']); return this; };
  Builder.prototype.order = function(col, opt){
    this.sortBy = col + '.' + (opt && opt.ascending === false ? 'desc' : 'asc');
    return this;
  };
  Builder.prototype.insert = function(v){ this.action = 'insert'; this.values = v; return this; };
  Builder.prototype.update = function(v){ this.action = 'update'; this.values = v; return this; };
  Builder.prototype.delete = function(){ this.action = 'delete'; return this; };
  Builder.prototype.maybeSingle = function(){ this.single = true; return this.exec(); };
  Builder.prototype.then = function(ok, bad){ return this.exec().then(ok, bad); };

  Builder.prototype.exec = function(){
    var qs = ['select=*'].concat(this.filters.map(toFilter));
    if(this.sortBy) qs.push('order=' + this.sortBy);
    var self = this;

    if(this.action === 'select'){
      qs.push('limit=1000');
      return request('GET', this.table, qs, null, null).then(function(r){
        if(r.error) return r;
        var rows = r.data || [];
        return { data: self.single ? (rows[0] || null) : rows };
      });
    }

    if(this.action === 'insert'){
      // simple 模式逐条提交（form-urlencoded 无法表达数组）
      if(isSimple() && Array.isArray(this.values)){
        var acc = [];
        var selfI = this;
        return this.values.reduce(function(p, row){
          return p.then(function(){
            return request('POST', selfI.table, ['select=*'], row, 'return=representation');
          }).then(function(r){
            if(r.error) throw new Error(r.error.message);
            if(r.data && r.data.length) acc = acc.concat(r.data);
            else acc.push(row);
            return null;
          });
        }, Promise.resolve()).then(function(){
          return { data: acc };
        });
      }
      var vals = this.values;
      return request('POST', this.table, ['select=*'], vals, 'return=representation').then(function(r){
        if(r.error) return r;
        if(r.data && r.data.length) return r;
        // 服务端未返回行：用提交内容兜底，保证调用方拿到结果
        return { data: [vals] };
      });
    }

    if(this.action === 'update'){
      var valsU = this.values;
      return request('PATCH', this.table, qs, valsU, 'return=representation').then(function(r){
        if(r.error) return r;
        if(r.data && r.data.length) return r;
        if(r.returnsRows) return { data: [valsU] };
        // 服务端不返回行且未声明会返回：回读一次拿真实值
        return request('GET', self.table, qs, null, null).then(function(g){
          if(g.error) return { data: [valsU] };
          return { data: (g.data && g.data.length) ? g.data : [valsU] };
        });
      });
    }

    if(this.action === 'delete'){
      // 服务端不返回受影响的行时，先查出来再删，才能把结果交给调用方
      var pre = null;
      if(isSimple() && !returnsRowsNow() && this.filters.length){
        pre = request('GET', this.table, qs, null, null).then(function(g){
          return (g && g.data && g.data.length) ? g.data : null;
        });
      }
      return Promise.resolve(pre).then(function(rowsBefore){
        return request('DELETE', self.table, qs, null, 'return=representation').then(function(r){
          if(r.error) return r;
          if(r.data && r.data.length) return r;
          return { data: rowsBefore || [] };
        });
      });
    }

    return Promise.resolve({ error: { message: '不支持的操作：' + this.action } });
  };

  function isSimple(){
    return CHANNELS.length > 0 && CHANNELS[0].mode === 'simple';
  }
  function returnsRowsNow(){
    return CHANNELS.length > 0 && !!CHANNELS[0].returnsRows;
  }

  // 逐个通道测速，用于页面里的「网络诊断」
  function diagnose(){
    var results = [];
    var chain = Promise.resolve();
    CHANNELS.forEach(function(ch){
      chain = chain.then(function(){
        var simple = ch.mode === 'simple';
        var base = baseOf(ch.url);
        var qs = simple
          ? 'select=id&limit=1&apikey=' + encodeURIComponent(KEY)
          : 'select=id&limit=1';
        var t0 = Date.now();
        var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var timer = ctrl ? setTimeout(function(){ ctrl.abort(); }, 15000) : null;
        var headers = simple ? {} : { 'apikey': KEY };
        return fetch(base + '/rest/v1/members?' + qs, {
          method: 'GET', headers: headers, signal: ctrl ? ctrl.signal : undefined
        }).then(function(res){
          if(timer) clearTimeout(timer);
          results.push({
            base: hostOf(base), mode: ch.mode, ok: res.ok, status: res.status, ms: Date.now() - t0
          });
        }).catch(function(e){
          if(timer) clearTimeout(timer);
          results.push({
            base: hostOf(base), mode: ch.mode, ok: false, status: 0, ms: Date.now() - t0,
            error: e && e.name === 'AbortError' ? '连接超时' : '连接被中断'
          });
        });
      });
    });
    return chain.then(function(){ return results; });
  }

  window.SupabaseDB = {
    /**
     * create(url, key, extraChannels)
     *   url/key      —— 兼容旧写法：直连 PostgREST 通道
     *   extraChannels—— 数组，元素可为字符串（视作 simple 模式中继）或
     *                   { url, mode: 'json'|'simple', returnsRows: true|false }
     */
    create: function(url, key, extra){
      KEY = key || '';
      var extraList = [];
      (extra || []).forEach(function(x){
        if(!x) return;
        if(typeof x === 'string') extraList.push({ url: x, mode: 'simple', returnsRows: true });
        else if(x.url) extraList.push({
          url: x.url,
          mode: x.mode || 'simple',
          returnsRows: x.returnsRows === undefined ? (x.mode === 'simple') : !!x.returnsRows
        });
      });
      // 备用通道（国内中继）优先，直连作为兜底：
      // 国内通道更稳定，且直连在跨境网络差时要等十几秒才失败
      var list = extraList.slice();
      if(url) list.push({ url: url, mode: 'json', returnsRows: true });
      CHANNELS = list;
      // 上次成功的通道排最前
      try {
        var last = localStorage.getItem(LAST_OK_KEY);
        if(last != null && list[last]){
          var t = list[last]; list.splice(last, 1); list.unshift(t);
        }
      } catch(e){}
      return {
        database: { from: function(t){ return new Builder(t); } },
        diagnose: diagnose,
        channels: function(){ return CHANNELS.map(function(c){ return { url: c.url, mode: c.mode }; }); }
      };
    }
  };
})();
