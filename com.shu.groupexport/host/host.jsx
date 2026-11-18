/* Photoshop ExtendScript (ES3). The original document is never saved; every change made
   while exporting is put back (visibility explicitly, everything else by history). */
var GroupExporter = (function () {
    // ownRedo: the history position this plugin left a document at after rolling back
    // its own export step, so that leftover (and only it) may be replaced next time.
    var captured = null, sequence = 0, step = null, ownRedo = null;
    var COMPOSITE_NAME = '__groupexport_composite__', LEGACY_WORK_NAME = '__groupexport_work__';
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
    // ---- ActionManager reads. They are fast on any PSD size, unlike the DOM layer
    // tree, and never depend on which groups are expanded in the Layers panel.
    function docProperty(name) {
        var r = new ActionReference(); r.putProperty(sid('property'), sid(name));
        r.putEnumerated(sid('document'), sid('ordinal'), sid('targetEnum'));
        return executeActionGet(r);
    }
    function layerProperty(id, name) {
        var r = new ActionReference();
        r.putProperty(sid('property'), sid(name)); r.putIdentifier(sid('layer'), id);
        return executeActionGet(r);
    }
    function indexProperty(index, name) {
        var r = new ActionReference();
        r.putProperty(sid('property'), sid(name)); r.putIndex(sid('layer'), index);
        return executeActionGet(r);
    }
    function hasBackground() { try { return docProperty('hasBackgroundLayer').getBoolean(sid('hasBackgroundLayer')); } catch (e) { return false; } }
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
    // The layers selected in the Layers panel, as IDs (possibly empty).
    function currentSelection(doc) {
        var d, list, out = [], i;
        try {
            d = docProperty('targetLayersIDs');
            if (d.hasKey(sid('targetLayersIDs'))) {
                list = d.getList(sid('targetLayersIDs'));
                for (i = 0; i < list.count; i++) { out.push(list.getReference(i).getIdentifier()); }
                return out;
            }
        } catch (ignore) {}
        try {
            // Older hosts: targetLayers lists indexes, offset by one without a background.
            d = docProperty('targetLayers');
            if (d.hasKey(sid('targetLayers'))) {
                list = d.getList(sid('targetLayers'));
                var offset = hasBackground() ? 0 : 1;
                for (i = 0; i < list.count; i++) { out.push(indexProperty(list.getReference(i).getIndex() + offset, 'layerID').getInteger(sid('layerID'))); }
                return out;
            }
        } catch (ignore2) {}
        try { out.push(doc.activeLayer.id); } catch (ignore3) {}
        return out;
    }
    // Where the document stands in its history: 1-based position of the current state,
    // number of states, and the current state's ID. null when the host cannot tell.
    function historyPosition() {
        try {
            var r = new ActionReference(); r.putProperty(sid('historyState'), sid('currentHistoryState'));
            var d = executeActionGet(r);
            if (d.hasKey(sid('itemIndex')) && d.hasKey(sid('count'))) {
                return {index:d.getInteger(sid('itemIndex')), count:d.getInteger(sid('count')), id:d.hasKey(sid('ID')) ? d.getInteger(sid('ID')) : null};
            }
        } catch (ignore) {}
        return null;
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
    // Registry of the temporary documents this plugin created, by document ID. It is
    // kept in Photoshop's custom options for the Photoshop session (not on disk), so it
    // survives a panel or host-script reload; document IDs are unique within a session.
    var REGISTRY = 'com.shu.groupexport.temporaryDocuments';
    function owned() {
        try { var text = app.getCustomOptions(REGISTRY).getString(sid('documentIDs')); return text ? text.split(',') : []; }
        catch (none) { return []; }
    }
    function saveOwned(ids) {
        if (!ids.length) { try { app.eraseCustomOptions(REGISTRY); } catch (none) {} return; }
        var d = new ActionDescriptor(); d.putString(sid('documentIDs'), ids.join(','));
        app.putCustomOptions(REGISTRY, d, false);
    }
    function own(doc) { var ids = owned(); ids.push(String(doc.id)); saveOwned(ids); return doc; }
    function disown(id) {
        var ids = owned(), keep = [];
        for (var i = 0; i < ids.length; i++) { if (ids[i] !== String(id)) { keep.push(ids[i]); } }
        saveOwned(keep);
    }
    // Closes temporary documents left behind when the panel was closed or reloaded
    // mid-export. A document is closed (never saved) only if this plugin registered it
    // AND it still has a reserved name; the active document is never touched, so a
    // user's PSD that merely shares the name is safe.
    function closeLeftovers() {
        var ids = owned(), keep = [], closed = 0, i, j, original = app.documents.length ? app.activeDocument : null;
        if (!ids.length) { return 0; }
        for (i = 0; i < ids.length; i++) {
            var doc = null;
            for (j = 0; j < app.documents.length; j++) { if (String(app.documents[j].id) === ids[i]) { doc = app.documents[j]; break; } }
            if (!doc) { continue; } // already closed: forget it
            var name = String(doc.name);
            if ((name === COMPOSITE_NAME || name === LEGACY_WORK_NAME) && !(original && doc.id === original.id)) { doc.close(SaveOptions.DONOTSAVECHANGES); closed++; }
            else { keep.push(ids[i]); }
        }
        saveOwned(keep);
        if (closed && original) { try { app.activeDocument = original; } catch (ignore) {} }
        return closed;
    }
    // mode 'self': every selected layer or group is one image.
    // mode 'children': every direct child of each selected group is one image.
    // One top-down pass over the flat ActionManager layer list (group start, its
    // children, then an end marker), reading only what is needed and stopping as soon
    // as every selected layer and every selected parent's children have been seen.
    function capture(mode) {
        try {
            try { closeLeftovers(); } catch (ignore) {}
            var children = mode === 'children';
            return withPixels(function () {
                var doc = active(), ids = currentSelection(doc), wanted = {}, remaining = 0, plainWanted = 0, i, j;
                if (!ids.length) { throw new Error('请先在图层面板中选中至少一个图层。'); }
                var START = sid('layerSectionStart'), END = sid('layerSectionEnd');
                for (i = 0; i < ids.length; i++) {
                    if (wanted['l' + ids[i]]) { continue; }
                    var section = null;
                    try { section = layerProperty(ids[i], 'layerSection').getEnumerationValue(sid('layerSection')); } catch (unknownLayer) {}
                    wanted['l' + ids[i]] = true; remaining++;
                    if (section !== START) { plainWanted++; }
                }
                var count = docProperty('numberOfLayers').getInteger(sid('numberOfLayers')), bottom = hasBackground() ? 0 : 1;
                var stack = [{id:null, path:[], names:[], chain:[], rect:null, counter:0, collect:false}], collecting = 0;
                var picked = [], collected = [], counts = {};
                function target(id, name, frame, branch, chain, rect, board, kind) {
                    return {id:id, name:name, kind:kind, parent:frame.names.length ? frame.names[frame.names.length - 1] : '', parentId:frame.id,
                        path:branch, chain:chain, breadcrumb:frame.names.concat([name]).join(' / '), rect:rect, board:!!board};
                }
                for (i = count; i >= bottom && (remaining || collecting); i--) {
                    var top = stack[stack.length - 1];
                    var kindOf = indexProperty(i, 'layerSection').getEnumerationValue(sid('layerSection'));
                    if (kindOf === END) { if (top.collect) { collecting--; } if (stack.length > 1) { stack.pop(); } continue; }
                    var group = kindOf === START, position = top.counter++;
                    // Plain layers matter only when collected under a selected parent or selected themselves.
                    if (!group && !top.collect && !plainWanted) { continue; }
                    var id = indexProperty(i, 'layerID').getInteger(sid('layerID')), selected = !!wanted['l' + id];
                    if (!group && !top.collect && !selected) { continue; }
                    var name = String(indexProperty(i, 'name').getString(sid('name')));
                    var branch = top.path.concat([position]), chain = top.chain.concat([id]);
                    // Artboards are always top-level groups in Photoshop.
                    var board = stack.length === 1 && group ? boardRect(id) : null, rect = board || top.rect;
                    if (top.collect) { collected.push(target(id, name, top, branch, chain, rect, board, group ? 'group' : 'layer')); counts['l' + top.id] = (counts['l' + top.id] || 0) + 1; }
                    if (selected) { remaining--; if (!group) { plainWanted--; } picked.push(target(id, name, top, branch, chain, rect, board, group ? 'group' : 'layer')); }
                    if (group) {
                        var frame = {id:id, path:branch, names:top.names.concat([name]), chain:chain, rect:rect, counter:0, collect:children && selected};
                        if (frame.collect) { collecting++; }
                        stack.push(frame);
                    }
                }
                if (remaining) { throw new Error('有 ' + remaining + ' 个选中的图层没有在图层列表中找到。请在图层面板中重新选择后再读取。'); }
                // A selection inside another selected group is ignored: Shift-selecting a
                // range of expanded folders also selects the layers inside them.
                var isPicked = {}, ignored = {}, ignoredCount = 0;
                for (i = 0; i < picked.length; i++) { isPicked['l' + picked[i].id] = true; }
                for (i = 0; i < picked.length; i++) {
                    for (j = 0; j < picked[i].chain.length - 1; j++) { if (isPicked['l' + picked[i].chain[j]]) { ignored['l' + picked[i].id] = true; ignoredCount++; break; } }
                }
                var found = [];
                if (children) {
                    for (i = 0; i < picked.length; i++) {
                        if (ignored['l' + picked[i].id]) { continue; }
                        if (!counts['l' + picked[i].id]) { throw new Error('「' + picked[i].name + '」下面没有可导出的图层。请选择图层的上一级，或切换为“直接选图层”。'); }
                    }
                    for (i = 0; i < collected.length; i++) { if (!ignored['l' + collected[i].parentId]) { found.push(collected[i]); } }
                } else {
                    for (i = 0; i < picked.length; i++) { if (!ignored['l' + picked[i].id]) { found.push(picked[i]); } }
                }
                for (i = 0; i < found.length; i++) {
                    for (j = i + 1; j < found.length; j++) {
                        if (contains(found[i].path, found[j].path) || contains(found[j].path, found[i].path)) {
                            throw new Error('「' + found[i].name + '」与「' + found[j].name + '」互相包含，无法分别导出。请只选同一层级的图层。');
                        }
                    }
                }
                found.sort(function (a, b) {
                    for (var k = 0; k < a.path.length && k < b.path.length; k++) { if (a.path[k] !== b.path[k]) { return a.path[k] - b.path[k]; } }
                    return a.path.length - b.path.length;
                });
                captured = {token:String(doc.id) + '-' + (++sequence), docId:doc.id, revision:revision(),
                    width:Math.round(px(doc.width)), height:Math.round(px(doc.height)), targets:found};
                return json({ok:true, token:captured.token, docId:doc.id, documentName:String(doc.name), targets:found, ignored:ignoredCount,
                    scanned:count - i, layers:count});
            });
        } catch (e) { return failure(e); }
    }
    function guard(token, ids) {
        var doc = active(), out = [], used = {}, i, j;
        if (!captured || captured.token !== token || doc.id !== captured.docId) { throw new Error('当前文档或图层清单已改变，请重新读取。'); }
        if ((captured.revision !== null && revision() !== captured.revision) ||
            Math.round(px(doc.width)) !== captured.width || Math.round(px(doc.height)) !== captured.height) {
            throw new Error('PSD 在读取后已被修改。请重新读取，再开始导出。');
        }
        if (!ids || !ids.length) { throw new Error('没有待导出的图层。'); }
        // Exporting adds a history step to the original. Linear history drops every
        // redoable state after the current one, so refuse before changing anything,
        // unless the only redoable state is the one this plugin's last export left.
        var position = historyPosition();
        if (position && position.count > position.index &&
            !(ownRedo && ownRedo.docId === doc.id && ownRedo.index === position.index && ownRedo.count === position.count && ownRedo.id === position.id)) {
            throw new Error('PSD 当前停在较早的历史记录上，后面还有 ' + (position.count - position.index) + ' 步可以重做。导出会清掉这些可重做的步骤，因此没有导出，原 PSD 未改动。' +
                '请在历史记录面板中点最后一步后重新读取；如果不再需要这些步骤，在 PSD 上做任意一次编辑后重新读取。');
        }
        // Every captured layer is checked by ID, including ones removed from the panel
        // list: all of them are hidden while another one is exported.
        for (j = 0; j < captured.targets.length; j++) {
            var t = captured.targets[j], name = null;
            try { name = String(layerProperty(t.id, 'name').getString(sid('name'))); } catch (missing) {}
            if (name !== t.name) { throw new Error('图层结构已改变，请重新读取。'); }
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
    // Show or hide many layers in one ActionManager call each.
    function setVisible(list, visible) {
        if (!list.length) { return; }
        var refs = new ActionList(), d = new ActionDescriptor();
        for (var i = 0; i < list.length; i++) { var r = new ActionReference(); r.putIdentifier(sid('layer'), list[i]); refs.putReference(r); }
        d.putList(sid('null'), refs);
        executeAction(sid(visible ? 'show' : 'hide'), d, DialogModes.NO);
    }
    function isVisible(id) { return layerProperty(id, 'visible').getBoolean(sid('visible')); }
    // Plans showing exactly one target (and its ancestors) and hiding every other
    // captured target. Every other target's branch is hidden where it forks off the
    // chosen target's ancestor chain: exporting C/D/图层 2 hides all of A when another
    // target is A/B/图层 1, so A's own background cannot leak in. Shared ancestors stay
    // on and layers outside every target branch keep their state. Only reads: the
    // caller applies the plan inside the block that restores it.
    function planVariant(all, chosen) {
        var hide = [], show = [], seen = {}, i, k;
        function want(id, visible) {
            if (seen['l' + id]) { return; } seen['l' + id] = true;
            if (isVisible(id) !== visible) { (visible ? show : hide).push(id); }
        }
        for (i = 0; i < all.length; i++) {
            if (all[i].id === chosen.id) { continue; }
            var other = all[i].chain; k = 0;
            while (k < other.length && k < chosen.chain.length && other[k] === chosen.chain[k]) { k++; }
            want(other[k], false);
            if (other[k] !== all[i].id) { want(all[i].id, false); }
        }
        for (i = 0; i < chosen.chain.length; i++) { want(chosen.chain[i], true); }
        return {hidden:hide, shown:show};
    }
    function applyVariant(plan) { setVisible(plan.hidden, false); setVisible(plan.shown, true); }
    // Puts back every layer the plan touches, whether or not applying it got that far
    // (setting a layer to its original state again is harmless). If a batch call fails,
    // each layer is retried on its own; both lists are always attempted.
    function restore(plan) {
        var failed = [], first = null;
        function put(list, visible) {
            try { setVisible(list, visible); return; } catch (batchError) { first = first || batchError; }
            for (var i = 0; i < list.length; i++) {
                try { setVisible([list[i]], visible); } catch (oneError) { failed.push(list[i]); }
            }
        }
        put(plan.shown, false); put(plan.hidden, true);
        if (failed.length) { throw new Error('原 PSD 有 ' + failed.length + ' 个图层的显示状态未能恢复（图层 ID：' + failed.join('、') + '），请检查图层面板：' + message(first)); }
    }
    // Same measure as Photoshop's own Export As for a folder (the 4 倍数导出 plugin):
    // the folder merged on its own — its visible layers, masks and effects — trimmed
    // to non-transparent pixels. Common layers and other targets never affect it.
    function ownBounds(doc, target) {
        var source = at(doc, target.path), copy, merged = null, b = null, error = null;
        if (!source || source.id !== target.id) { throw new Error('图层结构已改变，请重新读取。'); }
        copy = source.duplicate();
        try {
            if (target.kind === 'layer') {
                // A plain layer: bake its effects, smart object or text into pixels first.
                try { copy.rasterize(RasterizeType.ENTIRELAYER); } catch (alreadyPixels) {}
                b = copy.bounds;
            } else { merged = copy.merge(); copy = null; b = merged.bounds; }
        } catch (e) { error = e; }
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
    // A transparent document the size of the original canvas, in a colour mode that can
    // take the clipboard as is. Same size, so "paste in place" keeps every position.
    function blankLike(doc) {
        var mode = NewDocumentMode.RGB, bits = BitsPerChannelType.EIGHT, same = false, profile = null, made;
        if (doc.mode === DocumentMode.RGB) { mode = NewDocumentMode.RGB; same = true; }
        else if (doc.mode === DocumentMode.CMYK) { mode = NewDocumentMode.CMYK; same = true; }
        else if (doc.mode === DocumentMode.LAB) { mode = NewDocumentMode.LAB; same = true; }
        else if (doc.mode === DocumentMode.GRAYSCALE) { mode = NewDocumentMode.GRAYSCALE; same = true; }
        else if (doc.mode === DocumentMode.BITMAP) { mode = NewDocumentMode.GRAYSCALE; }
        if (same) { bits = doc.bitsPerChannel; try { profile = doc.colorProfileName; } catch (untagged) { profile = null; } }
        var w = new UnitValue(captured.width, 'px'), h = new UnitValue(captured.height, 'px');
        if (profile) {
            try { made = app.documents.add(w, h, doc.resolution, COMPOSITE_NAME, mode, DocumentFill.TRANSPARENT, 1, bits, profile); }
            catch (badProfile) { made = null; }
        }
        if (!made) { made = app.documents.add(w, h, doc.resolution, COMPOSITE_NAME, mode, DocumentFill.TRANSPARENT, 1, bits); }
        return own(made);
    }
    // Copy Merged on an area with no visible pixels fails with "Could not complete the
    // Copy Merged command because the selected area is empty." That error alone means
    // "transparent"; Photoshop has no error code for it, so the localized text is
    // matched. A user cancel (8007) never counts. Unknown text stops the export rather
    // than saving a blank image: a false "empty" would hide a real failure.
    var EMPTY_COPY = /selected area is empty|area is empty|(选区|选中的区域|所选区域|选取范围|選取範圍|選定的區域)(是|为|為)空|選択範囲.{0,6}空|選択された(範囲|領域).{0,4}空|ausgewählte Bereich ist leer|zone sélectionnée est vide|área seleccionada está vacía|area selezionata è vuota|область пуста/i;
    function emptyCopy(e) {
        if (e && (e.number === 8007 || e.number === -8007)) { return false; }
        return EMPTY_COPY.test(message(e));
    }
    function pasteInPlace() {
        var d = new ActionDescriptor();
        d.putBoolean(sid('inPlace'), true);
        d.putEnumerated(sid('antiAlias'), sid('antiAliasType'), sid('antiAliasNone'));
        executeAction(sid('paste'), d, DialogModes.NO);
    }
    function selectLayers(ids) {
        var i, d, r;
        if (!ids.length) {
            try { d = new ActionDescriptor(); r = new ActionReference(); r.putEnumerated(sid('layer'), sid('ordinal'), sid('targetEnum')); d.putReference(sid('null'), r); executeAction(sid('selectNoLayers'), d, DialogModes.NO); } catch (ignore) {}
            return;
        }
        for (i = 0; i < ids.length; i++) {
            d = new ActionDescriptor(); r = new ActionReference(); r.putIdentifier(sid('layer'), ids[i]); d.putReference(sid('null'), r);
            if (i) { d.putEnumerated(sid('selectionModifier'), sid('selectionModifierType'), sid('addToSelection')); }
            d.putBoolean(sid('makeVisible'), false);
            executeAction(sid('select'), d, DialogModes.NO);
        }
    }
    function sameList(a, b) {
        if (a.length !== b.length) { return false; }
        for (var i = 0; i < a.length; i++) { if (a[i] !== b[i]) { return false; } }
        return true;
    }
    // Runs fn on the original as a single history step, so it is undone in one go.
    function inOneStep(doc, fn) {
        step = {fn:fn, result:null, error:null, ran:false};
        try {
            try { doc.suspendHistory('图层组分批导出', 'GroupExporter.__step()'); }
            catch (unavailable) { if (step.ran) { throw unavailable; } runStep(); }
            if (step.error) { throw step.error; }
            return step.result;
        } finally { step = null; }
    }
    function runStep() { step.ran = true; try { step.result = step.fn(); } catch (e) { step.error = e; } }
    // The original stays open and is never duplicated: the target's visibility is set,
    // the visible composite of the export rectangle is copied (Copy Merged, which only
    // composites that area), then every change is put back. Only the copied pixels go
    // into a small temporary document that is cropped, converted and saved.
    function render(token, ids, targetId, scope, destination) {
        var original = null, composite = null, oldDialogs = app.displayDialogs, result = null, cleanupErrors = [];
        var before = null, reverted = true, picked = null;
        var clock = new Date().getTime(), timing = {};
        function lap(name) { var t = new Date().getTime(); timing[name] = t - clock; clock = t; }
        function revert() {
            if (reverted) { return; }
            reverted = true; app.activeDocument = original; original.activeHistoryState = before;
            // Remember where this left the history: the redoable step after it is ours.
            var position = historyPosition();
            ownRedo = position ? {docId:original.id, index:position.index, count:position.count, id:position.id} : null;
        }
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
                picked = currentSelection(original);
                lap('check');
                var rect = target.rect || [0, 0, captured.width, captured.height], copied = false;
                before = original.activeHistoryState; reverted = false;
                inOneStep(original, function () {
                    var plan = planVariant(checked.all, target), failed = null;
                    try {
                        applyVariant(plan); lap('show');
                        // An artboard target exports its whole artboard, like Export As.
                        if (scope === 'group' && !target.board) {
                            rect = intersect(rect, ownBounds(original, target)); lap('measure');
                            if (!(rect[2] > rect[0] && rect[3] > rect[1])) { throw new Error('「' + target.name + '」在画布或画板范围内没有可见内容，无法裁切导出。'); }
                        }
                        // Ancestor masks, group effects, blending and common visible layers
                        // are all in the composite Copy Merged takes.
                        var area = intersect(rect, [0, 0, captured.width, captured.height]);
                        if (area[2] > area[0] && area[3] > area[1]) {
                            original.selection.select([[area[0], area[1]], [area[2], area[1]], [area[2], area[3]], [area[0], area[3]]]);
                            try { original.selection.copy(true); copied = true; }
                            catch (copyError) {
                                // Only Photoshop's "selected area is empty" means a transparent
                                // image; memory, scratch disk, cancel or anything else stops.
                                if (!emptyCopy(copyError)) { throw new Error('合并拷贝失败，没有导出：' + message(copyError)); }
                            }
                            original.selection.deselect();
                        }
                        lap('copy');
                    } catch (e) { failed = e; }
                    try { restore(plan); }
                    catch (restoreError) { failed = failed ? new Error(message(failed) + '；' + message(restoreError)) : restoreError; }
                    if (failed) { throw failed; }
                });
                revert(); lap('restore');
                composite = blankLike(original);
                app.activeDocument = composite;
                if (copied) {
                    pasteInPlace();
                    try { app.purge(PurgeTarget.CLIPBOARDCACHE); } catch (ignorePurge) {}
                    var b = composite.activeLayer.bounds, pb = [px(b[0]), px(b[1]), px(b[2]), px(b[3])];
                    if (pb[0] < rect[0] - 1 || pb[1] < rect[1] - 1 || pb[2] > rect[2] + 1 || pb[3] > rect[3] + 1) { throw new Error('粘贴位置异常，未保存。请把诊断信息发给开发者。'); }
                }
                crop(composite, rect); lap('compose');
                toSRGB8(composite); lap('convert');
                var options = new PNGSaveOptions(); options.interlaced = false; options.compression = 6;
                composite.saveAs(file, options, true, Extension.LOWERCASE);
                if (!file.exists) { throw new Error('Photoshop 没有生成 PNG 文件。'); }
                lap('save');
                return {ok:true, name:target.name, width:Math.round(px(composite.width)), height:Math.round(px(composite.height)), rect:rect, empty:!copied, timing:timing};
            });
        } catch (e) { result = {ok:false, message:message(e), timing:timing, line:e.line || null}; }
        finally {
            if (composite) { try { var compositeId = composite.id; composite.close(SaveOptions.DONOTSAVECHANGES); disown(compositeId); } catch (closeError) { cleanupErrors.push(message(closeError)); } }
            if (original) {
                try { revert(); } catch (revertError) { cleanupErrors.push('原 PSD 未能恢复到导出前的历史记录：' + message(revertError)); }
                try { app.activeDocument = original; } catch (activateError) { cleanupErrors.push(message(activateError)); }
                if (picked) { try { if (!sameList(currentSelection(original), picked)) { selectLayers(picked); } } catch (selectError) {} }
            }
            app.displayDialogs = oldDialogs;
        }
        if (cleanupErrors.length) { return json({ok:false, message:'导出后清理未完成：' + cleanupErrors.join('；') + '。请检查原 PSD，并关闭 ' + COMPOSITE_NAME + '（不要保存）。'}); }
        return json(result);
    }
    function release() {
        var original = app.documents.length ? app.activeDocument : null;
        try { closeLeftovers(); }
        catch (e) { return json({ok:false, message:'临时文档 ' + COMPOSITE_NAME + ' 未能关闭，请手动关闭（不要保存）。' + message(e)}); }
        finally { if (original) { try { app.activeDocument = original; } catch (ignore) {} } }
        return json({ok:true});
    }
    // Read-only facts for the diagnostic text. Every field is optional.
    function environment() {
        var out = {ok:true, photoshop:String(app.version), os:String($.os), openDocuments:app.documents.length,
            captured:captured ? {token:captured.token, targets:captured.targets.length, revision:captured.revision} : null};
        try { out.freeMemoryMB = Math.round(app.freeMemory / 1048576); } catch (ignore) {}
        try { out.rulerUnits = String(app.preferences.rulerUnits); } catch (ignore2) {}
        if (!app.documents.length) { return json(out); }
        var doc = app.activeDocument, d = {name:String(doc.name), id:doc.id};
        try { withPixels(function () { d.width = Math.round(px(doc.width)); d.height = Math.round(px(doc.height)); }); } catch (ignore3) {}
        try { d.resolution = doc.resolution; d.mode = String(doc.mode); d.bits = String(doc.bitsPerChannel); } catch (ignore4) {}
        try { d.fileMB = Math.round(new File(doc.fullName).length / 1048576); } catch (ignore5) { d.unsaved = true; }
        try { d.layers = docProperty('numberOfLayers').getInteger(sid('numberOfLayers')); } catch (ignore6) {}
        try { d.selection = currentSelection(doc); } catch (ignore7) {}
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
    return {capture:capture, validate:validate, render:render, release:release, __step:runStep,
        environment:function () { try { return environment(); } catch (e) { return failure(e); } }, chooseDirectory:chooseDirectory, openDirectory:openDirectory};
}());
