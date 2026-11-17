/*
 * Supabase 数据层（PostgREST 直连，无需加载官方 SDK）
 * 对外暴露与原来一致的链式接口：
 *   db.from('members').select('*').order('id',{ascending:true})
 *   db.from('checkins').select('*').eq('day','2026-11-16').maybeSingle()
 *   db.from('members').insert(row).select()
 *   db.from('members').update({name:'x'}).eq('id',1).select()
 *   db.from('members').delete().eq('id',1).select()
 * 返回 { data } 或 { error: { message } }，与 page 里的 q() 兼容。
 * 读请求（GET）失败会自动重试，写请求不重试以免重复登记。
 */
(function(){
  var URL_BASE = '';
  var KEY = '';
  var TIMEOUT = 20000;   // 国内访问境外 Supabase 常需十几秒，超时放宽到 20 秒
  var RETRY = 2;         // 读请求最多重试 2 次（共 3 次尝试）

  function toFilter(f){
    var v = String(f[1]);
    switch(f[2]){
      case 'lt': return f[0] + '=lt.' + encodeURIComponent(v);
      case 'lte': return f[0] + '=lte.' + encodeURIComponent(v);
      case 'gt': return f[0] + '=gt.' + encodeURIComponent(v);
      default: return f[0] + '=eq.' + encodeURIComponent(v);
    }
  }

  function request(method, path, query, body, prefer, tries){
    var left = (tries == null) ? RETRY : tries;
    var url = URL_BASE.replace(/\/$/, '') + '/rest/v1/' + path + (query && query.length ? '?' + query.join('&') : '');
    var headers = {
      'apikey': KEY,
      'Authorization': 'Bearer ' + KEY,
      'Content-Type': 'application/json'
    };
    if(prefer) headers['Prefer'] = prefer;
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function(){ ctrl.abort(); }, TIMEOUT) : null;
    return fetch(url, {
      method: method,
      headers: headers,
      body: body == null ? undefined : JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function(res){
      if(timer) clearTimeout(timer);
      return res.text().then(function(text){
        var json = null;
        try { json = text ? JSON.parse(text) : null; } catch(e){}
        if(!res.ok){
          var msg = (json && (json.message || json.hint || json.details)) || ('请求失败 ' + res.status);
          // 读请求遇到服务端临时错误（5xx）也重试；写请求不重试
          if(method === 'GET' && res.status >= 500 && left > 0){
            return request(method, path, query, body, prefer, left - 1);
          }
          return { error: { message: msg } };
        }
        return { data: json };
      });
    }, function(e){
      if(timer) clearTimeout(timer);
      var msg = e && e.name === 'AbortError' ? '请求超时，请检查网络后重试' : '网络连接失败，请重试';
      // 只重试读请求；写请求失败直接报错，避免重复登记
      if(method === 'GET' && left > 0){
        return request(method, path, query, body, prefer, left - 1);
      }
      return { error: { message: msg } };
    });
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
      return request('GET', this.table, qs, null).then(function(r){
        if(r.error) return r;
        var rows = r.data || [];
        return { data: self.single ? (rows[0] || null) : rows };
      });
    }
    if(this.action === 'insert'){
      return request('POST', this.table, ['select=*'], this.values, 'return=representation');
    }
    if(this.action === 'update'){
      return request('PATCH', this.table, qs, this.values, 'return=representation');
    }
    if(this.action === 'delete'){
      return request('DELETE', this.table, qs, null, 'return=representation');
    }
    return Promise.resolve({ error: { message: '不支持的操作：' + this.action } });
  };

  window.SupabaseDB = {
    create: function(url, key){
      URL_BASE = url || '';
      KEY = key || '';
      return { database: { from: function(t){ return new Builder(t); } } };
    }
  };
})();
