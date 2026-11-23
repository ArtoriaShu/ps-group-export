(function () {
  var targets = [
    {id:11, name:'图层 01', breadcrumb:'主视觉 / 产品图 / 图层 01'},
    {id:12, name:'图层 02', breadcrumb:'主视觉 / 产品图 / 图层 02'},
    {id:13, name:'图层 03', breadcrumb:'备用视觉 / 图层 03'}
  ];
  window.__adobe_cep__ = {evalScript: function (script, callback) {
    window.setTimeout(function () {
      var result = {ok:true};
      if (/\.capture\(/.test(script)) result = {ok:true, token:'demo', documentName:'产品主视觉.psd', common:['#公共 背景', '#公共 Logo'], targets:(/children/.test(script) ? targets.concat([
        {id:14, kind:'layer', name:'图层 04', breadcrumb:'主视觉 / 产品图 / 图层 04'}, {id:15, kind:'layer', name:'图层 05', breadcrumb:'主视觉 / 产品图 / 图层 05'}]).filter(function (t) { return /产品图/.test(t.breadcrumb); }) : targets).map(function (t) { return Object.assign({parent: t.breadcrumb.split(' / ').slice(-2)[0]}, t); })};
      if (/\.chooseDirectory\(/.test(script)) result = {ok:true, path:'D:\\设计项目\\产品主视觉\\导出'};
      callback(JSON.stringify(result));
    }, 200);
  }};
  window.GroupExportPreview = {
    fileName:function (s) { return s + '.png'; }, safeName:function (s) { return s; },
    run:function (o, request, done) {
      var count = 0, stopped = false, records = [];
      function next() {
        if (stopped || count === request.targets.length) { done(null, {records:records, total:request.targets.length, cancelled:stopped}); return; }
        var target = request.targets[count]; request.onProgress({phase:'render', completed:count, total:request.targets.length, current:target.name});
        window.setTimeout(function () {
          if (!stopped) records.push({name:target.name, file:target.name + '.png', width:800, height:600});
          count++; next();
        }, 1000);
      }
      window.setTimeout(next, 0); return {cancel:function () { stopped = true; }};
    }
  };
}());
