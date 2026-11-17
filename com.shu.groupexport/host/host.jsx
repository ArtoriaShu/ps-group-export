/* Photoshop ExtendScript (ES3). Original documents are read only. */
var GroupExporter = (function () {
    var captured = null, sequence = 0, session = null;
    var WORK_NAME = '__groupexport_work__';
    function sid(s) { return stringIDToTypeID(s); }
    function quote(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\x00-\x1f\u2028\u2029]/g, function (c) { return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4); }) + '"'; }
    function json(v) {
        var t = typeof v, a = [], k, i;
        if (v === null || t === 'undefined') { return 'null'; }
        if (t === 'string') { return quote(v); }
        if (t === 'number') { return isFinite(v) ? String(v) : 'null'; }
        if (t === 'boolean') { return v ? 'true' : 'false'; }
        if (v instanceof Array) { for (i = 0; i < v.length; i++) { a.push(json(v[i])); } return '[' + a.join(',') + ']'; }
        for (k in v) { if (v.hasOwnProperty(k)) { a.push(quote(k) + ':' + json(v[k])); } }
        return '{' + a.join(',') + '}';
    }
    function message(e) { return String(e.message || e); }
    function failure(e) { return json({ok:false, message:message(e)}); }
    // Every measurement runs with pixel rulers: DOM UnitValues come back in ruler
    // units, and cm/mm/% rulers would otherwise skew sizes and crop rectangles.
    function withPixels(fn) {
        var old = null;
        try { old = app.preferences.rulerUnits; app.preferences.rulerUnits = Units.PIXELS; } catch (ignore) { old = null; }
        try { return fn(); }
        finally { if (old !== null) { try { app.preferences.rulerUnits = old; } catch (ignore2) {} } }
    }
    function active() {
        if (!app.documents.length) { throw new Error('请先打开 PSD，然后选择需要导出的图层。'); }
        return app.activeDocument;
    }
    function layerProperty(id, name) {
        var r = new ActionReference();
        r.putProperty(sid('property'), sid(name)); r.putIdentifier(sid('layer'), id);
        return executeActionGet(r);
    }
    function revision() {
        var r, d;
        try {
            r = new ActionReference(); r.putProperty(sid('historyState'), sid('currentHistoryState'));
            d = executeActionGet(r); if (d.hasKey(sid('ID'))) { return String(d.getInteger(sid('ID'))); }
        } catch (ignore) {}
        try {
            r = new ActionReference(); r.putEnumerated(sid('historyState'), sid('ordinal'), sid('targetEnum'));
            d = executeActionGet(r); if (d.hasKey(sid('ID'))) { return String(d.getInteger(sid('ID'))); }
        } catch (ignore2) {}
        return null;
    }
    // Fallback when history IDs are unavailable. DOM wrappers are new objects on every
    // read, so compare values, never object identity.
    function historySignature(doc) {
        try { return String(doc.historyStates.length) + '|' + String(doc.activeHistoryState.name); } catch (ignore) { return null; }
    }
    function selectedIDs(doc) {
        var r = new ActionReference(); r.putProperty(sid('property'), sid('targetLayersIDs'));
        r.putEnumerated(sid('document'), sid('ordinal'), sid('targetEnum'));
        var d = executeActionGet(r), out = [], i;
        if (d.hasKey(sid('targetLayersIDs'))) {
            var list = d.getList(sid('targetLayersIDs'));
            for (i = 0; i < list.count; i++) { out.push(list.getReference(i).getIdentifier()); }
            if (!out.length) { throw new Error('请先在图层面板中选中至少一个图层。'); }
            return out;
        }
        // Very old hosts without targetLayersIDs: only the active layer is known.
        out.push(doc.activeLayer.id);
        return out;
    }
    function px(v) { return typeof v === 'number' ? v : v.as('px'); }
    function scalar(d, key) {
        try { return d.getUnitDoubleValue(sid(key)); } catch (ignore) { return d.getDouble(sid(key)); }
    }
    function boardRect(id) {
        var d = layerProperty(id, 'artboardEnabled');
        if (!d.hasKey(sid('artboardEnabled')) || !d.getBoolean(sid('artboardEnabled'))) { return null; }
        var rect = layerProperty(id, 'artboard').getObjectValue(sid('artboard')).getObjectValue(sid('artboardRect'));
        return [scalar(rect, 'left'), scalar(rect, 'top'), scalar(rect, 'right'), scalar(rect, 'bottom')];
    }
    function remainingCheck(ids) {
        var seen = {}, n = 0;
        for (var i = 0; i < ids.length; i++) { if (!seen['l' + ids[i]]) { seen['l' + ids[i]] = true; n++; } }
        return n;
    }
    function contains(a, b) {
        if (a.length >= b.length) { return false; }
        for (var i = 0; i < a.length; i++) { if (a[i] !== b[i]) { return false; } }
        return true;
    }
    function at(doc, path) {
        var node = doc;
        for (var i = 0; i < path.length; i++) {
            if (!node.layers || path[i] >= node.layers.length) { return null; }
            node = node.layers[path[i]];
        }
        return node;
    }
    function findDocument(id) {
        for (var i = 0; i < app.documents.length; i++) { if (app.documents[i].id === id) { return app.documents[i]; } }
        return null;
    }
    // The working copy lives for one batch, so the PSD is duplicated once per batch
    // instead of once per image. It is closed by release(), a new capture, or any error.
    function closeSession() {
        var s = session; session = null;
        if (!s) { return; }
        var doc = findDocument(s.docId);
        if (doc) { doc.close(SaveOptions.DONOTSAVECHANGES); }
    }
    function workingCopy(original) {
        if (session && session.token === captured.token) {
            var existing = findDocument(session.docId);
            if (existing) { return existing; }
        }
        closeSession();
        var working = original.duplicate(WORK_NAME, false);
        session = {token:captured.token, docId:working.id};
        return working;
    }
    // mode 'self': every selected folder is one image.
    // mode 'children': every direct sub-folder of each selected folder is one image.
    function capture(mode) {
        try {
            try { closeSession(); } catch (ignore) {}
            var children = mode === 'children';
            return withPixels(function () {
                var doc = active(), ids = selectedIDs(doc), wanted = {}, remaining = 0, plainWanted = 0, found = [], counts = {}, i;
                // Classify the selected IDs first. Plain (non-group) layers are valid targets
                // too, but reading every plain layer's ID is slow on big PSDs, so the walk only
                // does that while a selected plain layer is still unfound.
                for (i = 0; i < ids.length; i++) {
                    if (wanted['l' + ids[i]]) { continue; }
                    var section = layerProperty(ids[i], 'layerSection').getEnumerationValue(sid('layerSection'));
                    wanted['l' + ids[i]] = true; remaining++;
                    if (section !== sid('layerSectionStart')) { plainWanted++; }
                }
                function target(id, name, parentName, branch, title, rect, own, kind) {
                    return {id:id, name:name, kind:kind, parent:parentName, path:branch, breadcrumb:title.join(' / '), rect:rect, board:!!own};
                }
                // collect: the parent is selected in 'children' mode, so each of its direct
                // children (folders and plain layers) becomes a target; the walk must not stop early.
                function scan(parent, path, names, inheritedRect, top, collect) {
                    for (var j = 0; j < parent.layers.length && (remaining || collect); j++) {
                        var layer = parent.layers[j], group = layer.typename === 'LayerSet';
                        if (!group && !collect && !plainWanted) { continue; }
                        var id = layer.id, selected = !!wanted['l' + id];
                        if (!group && !collect && !selected) { continue; }
                        var name = String(layer.name), branch = path.concat([j]), title = names.concat([name]);
                        // Artboards are always top-level groups in Photoshop.
                        var own = top && group ? boardRect(id) : null, rect = own || inheritedRect;
                        var parentName = names.length ? names[names.length - 1] : '', kind = group ? 'group' : 'layer';
                        if (collect) {
                            found.push(target(id, name, parentName, branch, title, rect, own, kind));
                            counts['l' + parent.id] = (counts['l' + parent.id] || 0) + 1;
                        }
                        if (selected) {
                            remaining--; if (!group) { plainWanted--; }
                            if (!children) { found.push(target(id, name, parentName, branch, title, rect, own, kind)); }
                        }
                        if (group) { scan(layer, branch, title, rect, false, children && selected); }
                    }
                }
                scan(doc, [], [], null, true, false);
                if (remaining) { throw new Error('部分选择无法识别。请在图层面板中重新选择。'); }
                if (children) {
                    for (i = 0; i < ids.length; i++) {
                        if (!counts['l' + ids[i]]) { throw new Error('「' + layerProperty(ids[i], 'name').getString(sid('name')) + '」下面没有可导出的图层。请选择图层的上一级，或切换为“直接选图层”。'); }
                    }
                } else if (found.length !== remainingCheck(ids)) { throw new Error('部分选择无法识别。请在图层面板中重新选择。'); }
                for (i = 0; i < found.length; i++) {
                    for (var j = i + 1; j < found.length; j++) {
                        if (contains(found[i].path, found[j].path) || contains(found[j].path, found[i].path)) {
                            throw new Error(children ? '选中的上级文件夹互相包含（「' + found[i].name + '」与「' + found[j].name + '」重叠）。请只选同一层级、互不包含的上级文件夹。'
                                                     : '不能同时选择一个图层组及其内部的图层。请只选需要分别导出的那一层。');
                        }
                    }
                }
                found.sort(function (a, b) {
                    for (var k = 0; k < a.path.length && k < b.path.length; k++) { if (a.path[k] !== b.path[k]) { return a.path[k] - b.path[k]; } }
                    return a.path.length - b.path.length;
                });
                captured = {token:String(doc.id) + '-' + (++sequence), docId:doc.id, revision:revision(), history:historySignature(doc),
                    width:Math.round(px(doc.width)), height:Math.round(px(doc.height)), targets:found};
                return json({ok:true, token:captured.token, docId:doc.id, documentName:String(doc.name), targets:found});
            });
        } catch (e) { return failure(e); }
    }
    function guard(token, ids) {
        var doc = active(), out = [], used = {}, i, j;
        if (!captured || captured.token !== token || doc.id !== captured.docId) { throw new Error('当前文档或图层清单已改变，请重新读取。'); }
        var rev = revision();
        if ((captured.revision !== null && rev !== captured.revision) ||
            (captured.revision === null && historySignature(doc) !== captured.history) ||
            Math.round(px(doc.width)) !== captured.width || Math.round(px(doc.height)) !== captured.height) {
            throw new Error('PSD 在读取后已被修改。请重新读取，再开始导出。');
        }
        if (!ids || !ids.length) { throw new Error('没有待导出的图层。'); }
        // Every captured folder is checked, including ones removed from the panel list:
        // all of them are hidden while another folder is exported.
        for (j = 0; j < captured.targets.length; j++) {
            var t = captured.targets[j], layer = at(doc, t.path);
            if (!layer || layer.id !== t.id || String(layer.name) !== t.name) { throw new Error('图层结构已改变，请重新读取。'); }
        }
        for (i = 0; i < ids.length; i++) {
            var target = null;
            if (used['l' + ids[i]]) { throw new Error('导出清单包含重复图层，请重新读取。'); }
            used['l' + ids[i]] = true;
            for (j = 0; j < captured.targets.length; j++) { if (captured.targets[j].id === ids[i]) { target = captured.targets[j]; break; } }
            if (!target) { throw new Error('图层不在读取的清单中，请重新读取。'); }
            out.push(target);
        }
        return {doc:doc, targets:out, all:captured.targets};
    }
    function validate(token, ids) { try { return withPixels(function () { guard(token, ids); return json({ok:true}); }); } catch (e) { return failure(e); } }
    // Shows exactly one variant (and its ancestors) and hides every other captured
    // variant. Returns what changed so the shared working copy can be put back.
    function isPrefix(a, b) {
        if (a.length > b.length) { return false; }
        for (var i = 0; i < a.length; i++) { if (a[i] !== b[i]) { return false; } }
        return true;
    }
    function showVariant(doc, all, chosen) {
        var changed = [], i, node;
        function set(layer, path, visible) {
            if (layer.visible !== visible) { changed.push({layer:layer, depth:path.length, visible:layer.visible}); layer.visible = visible; }
        }
        for (i = 0; i < all.length; i++) { if (all[i].id !== chosen.id) { set(at(doc, all[i].path), all[i].path, false); } }
        // The parent group of every other captured folder is hidden as a whole, so
        // that group's own layers (a background placed beside its variants, say) do
        // not leak into this image. A parent that is also an ancestor of the chosen
        // folder stays on, and layers outside all of these parents are untouched.
        for (i = 0; i < all.length; i++) {
            var parentPath = all[i].path.slice(0, -1);
            if (all[i].id === chosen.id || !parentPath.length || isPrefix(parentPath, chosen.path)) { continue; }
            set(at(doc, parentPath), parentPath, false);
        }
        node = doc;
        for (i = 0; i < chosen.path.length; i++) { node = node.layers[chosen.path[i]]; set(node, chosen.path.slice(0, i + 1), true); }
        return changed;
    }
    function restore(changed) {
        // Deepest first, ancestors last, so a parent always ends with its own value.
        changed.sort(function (a, b) { return b.depth - a.depth; });
        for (var i = 0; i < changed.length; i++) { changed[i].layer.visible = changed[i].visible; }
    }
    // Same measure as Photoshop's own Export As for a folder (the 4 倍数导出 plugin):
    // the folder merged on its own — its visible layers, masks and effects — trimmed
    // to non-transparent pixels. Common layers and other variants never affect it.
    function ownBounds(doc, target) {
        var source = at(doc, target.path), copy = source.duplicate(), merged = null, b = null, error = null;
        try {
            if (target.kind === 'layer') {
                // A plain layer: bake its effects, smart object or text into pixels first.
                try { copy.rasterize(RasterizeType.ENTIRELAYER); } catch (alreadyPixels) {}
                b = copy.bounds;
            } else { merged = copy.merge(); copy = null; b = merged.bounds; }
        } catch (e) { error = e; }
        // Removal errors propagate: the working copy is then discarded by the caller.
        if (merged) { merged.remove(); } else if (copy) { copy.remove(); }
        if (error || !b || !(px(b[2]) > px(b[0]) && px(b[3]) > px(b[1]))) { throw new Error('「' + target.name + '」没有可见内容，无法裁切导出。请确认图层内容和蒙版。'); }
        return [Math.floor(px(b[0])), Math.floor(px(b[1])), Math.ceil(px(b[2])), Math.ceil(px(b[3]))];
    }
    function intersect(a, b) { return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]; }
    function crop(doc, rect) {
        doc.crop([new UnitValue(rect[0], 'px'), new UnitValue(rect[1], 'px'), new UnitValue(rect[2], 'px'), new UnitValue(rect[3], 'px')]);
    }
    function checkMode(doc) {
        if (doc.bitsPerChannel === BitsPerChannelType.THIRTYTWO) { throw new Error('暂不支持 32 位 PSD。请先在“图像 → 模式”中转为 16 位或 8 位后重新读取。'); }
        if (doc.mode === DocumentMode.MULTICHANNEL) { throw new Error('暂不支持多通道模式的 PSD。请先转为 RGB 后重新读取。'); }
    }
    function toSRGB8(doc) {
        if (doc.mode === DocumentMode.BITMAP) { doc.changeMode(ChangeMode.GRAYSCALE); }
        if (doc.mode !== DocumentMode.RGB) { doc.changeMode(ChangeMode.RGB); }
        if (doc.bitsPerChannel !== BitsPerChannelType.EIGHT) { doc.bitsPerChannel = BitsPerChannelType.EIGHT; }
        doc.convertProfile('sRGB IEC61966-2.1', Intent.RELATIVECOLORIMETRIC, true, true);
    }
    function render(token, ids, targetId, scope, destination) {
        var original = null, composite = null, oldDialogs = app.displayDialogs, result = null, cleanupErrors = [], discard = false;
        var clock = new Date().getTime(), timing = {};
        function lap(name) { var t = new Date().getTime(); timing[name] = t - clock; clock = t; }
        try {
            result = withPixels(function () {
                if (scope !== 'group' && scope !== 'canvas') { throw new Error('未知的导出范围。'); }
                var checked = guard(token, ids), target = null, i;
                original = checked.doc;
                for (i = 0; i < checked.targets.length; i++) { if (checked.targets[i].id === targetId) { target = checked.targets[i]; break; } }
                if (!target) { throw new Error('当前图层不在导出清单中。'); }
                checkMode(original);
                var file = new File(destination);
                if (!file.parent.exists || file.exists) { throw new Error('临时输出目录不存在，或临时文件已经存在。'); }
                app.displayDialogs = DialogModes.NO;
                discard = true; // until the working copy is back in its pristine state
                var reused = !!(session && session.token === captured.token && findDocument(session.docId));
                var working = workingCopy(original);
                lap(reused ? 'reuse' : 'duplicate');
                app.activeDocument = working;
                var changed = showVariant(working, checked.all, target);
                var rect = target.rect || [0, 0, captured.width, captured.height];
                try {
                    // An artboard folder exports its whole artboard, like Export As.
                    if (scope === 'group' && !target.board) {
                        rect = intersect(rect, ownBounds(working, target)); lap('measure');
                        if (!(rect[2] > rect[0] && rect[3] > rect[1])) { throw new Error('「' + target.name + '」在画布或画板范围内没有可见内容，无法裁切导出。'); }
                    }
                    // Composite the whole hierarchy before cropping, so ancestor masks,
                    // group effects, blending and common visible layers are baked together.
                    composite = working.duplicate('__groupexport_composite__', true); lap('composite');
                } finally {
                    app.activeDocument = working;
                    restore(changed);
                }
                discard = false;
                app.activeDocument = composite;
                crop(composite, rect);
                toSRGB8(composite); lap('convert');
                var options = new PNGSaveOptions(); options.interlaced = false; options.compression = 6;
                composite.saveAs(file, options, true, Extension.LOWERCASE);
                if (!file.exists) { throw new Error('Photoshop 没有生成 PNG 文件。'); }
                lap('save');
                return {ok:true, name:target.name, width:Math.round(px(composite.width)), height:Math.round(px(composite.height)), rect:rect, timing:timing};
            });
        } catch (e) { result = {ok:false, message:message(e), timing:timing, line:e.line || null}; }
        finally {
            if (composite) { try { composite.close(SaveOptions.DONOTSAVECHANGES); } catch (closeError) { cleanupErrors.push(message(closeError)); } }
            if (discard) { try { closeSession(); } catch (sessionError) { cleanupErrors.push(message(sessionError)); } }
            app.displayDialogs = oldDialogs;
            if (original) { try { app.activeDocument = original; } catch (activateError) { cleanupErrors.push(message(activateError)); } }
        }
        if (cleanupErrors.length) { return json({ok:false, message:'临时文档未能完全关闭，请关闭 __groupexport_ 开头的临时文档后重试。' + cleanupErrors.join('；')}); }
        return json(result);
    }
    function release() {
        var original = app.documents.length ? app.activeDocument : null;
        try { closeSession(); }
        catch (e) { return json({ok:false, message:'临时文档 ' + WORK_NAME + ' 未能关闭，请手动关闭（不要保存）。' + message(e)}); }
        finally { if (original) { try { app.activeDocument = original; } catch (ignore) {} } }
        return json({ok:true});
    }
    // Read-only facts for the diagnostic text. Every field is optional.
    function environment() {
        var out = {ok:true, photoshop:String(app.version), os:String($.os), openDocuments:app.documents.length, session:session ? session.token : null,
            captured:captured ? {token:captured.token, targets:captured.targets.length, revision:captured.revision} : null};
        try { out.freeMemoryMB = Math.round(app.freeMemory / 1048576); } catch (ignore) {}
        try { out.rulerUnits = String(app.preferences.rulerUnits); } catch (ignore2) {}
        if (!app.documents.length) { return json(out); }
        var doc = app.activeDocument, d = {name:String(doc.name), id:doc.id};
        try { withPixels(function () { d.width = Math.round(px(doc.width)); d.height = Math.round(px(doc.height)); }); } catch (ignore3) {}
        try { d.resolution = doc.resolution; d.mode = String(doc.mode); d.bits = String(doc.bitsPerChannel); } catch (ignore4) {}
        try { d.fileMB = Math.round(new File(doc.fullName).length / 1048576); } catch (ignore5) { d.unsaved = true; }
        try {
            var r = new ActionReference(); r.putProperty(sid('property'), sid('numberOfLayers')); r.putEnumerated(sid('document'), sid('ordinal'), sid('targetEnum'));
            d.layers = executeActionGet(r).getInteger(sid('numberOfLayers'));
        } catch (ignore6) {}
        out.document = d;
        return json(out);
    }
    function chooseDirectory(previous) {
        try {
            var start = previous ? new Folder(previous) : null;
            var chosen = start && start.exists ? start.selectDlg('选择图层组分批导出的保存目录') : Folder.selectDialog('选择图层组分批导出的保存目录');
            return chosen ? json({ok:true, path:chosen.fsName}) : json({ok:false, cancelled:true});
        } catch (e) { return failure(e); }
    }
    function openDirectory(path) {
        try {
            var folder = new Folder(path);
            if (!folder.exists || !folder.execute()) { throw new Error('无法打开此导出目录。'); }
            return json({ok:true});
        } catch (e) { return failure(e); }
    }
    return {capture:capture, validate:validate, render:render, release:release,
        environment:function () { try { return environment(); } catch (e) { return failure(e); } }, chooseDirectory:chooseDirectory, openDirectory:openDirectory};
}());
