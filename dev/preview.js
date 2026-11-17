fetch('../com.shu.groupexport/index.html').then(function (r) { return r.text(); }).then(function (html) {
  var base = new URL('../com.shu.groupexport/', window.location.href).href;
  html = html.replace('<head>', '<head><base href="' + base + '">');
  html = html.replace('<script src="js/panel.js">', '<script src="../dev/mock.js"></script><script src="js/panel.js">');
  document.getElementById('panel').srcdoc = html;
});
