// The browser owns composition and replacement edits. The application owns
// accepted field state. Do not turn an IME update into simulated key presses.
let request = { active: null, activation_regions: [] };
let geometry = null;
let textarea = null;
let canvas = null;
let pending = [];
let observed = null;
let composing = false;
let activating = false;
let suspended = false;
let savedTransform = '';

function scalarOffset(text, units) {
    let n = 0, used = 0;
    for (const c of text) { used += c.length; if (used > units) break; n++; }
    return n;
}
function utf16Offset(text, scalars) { return Array.from(text).slice(0, scalars).join('').length; }
function readState() {
    const text = textarea.value;
    const start = scalarOffset(text, textarea.selectionStart);
    const end = scalarOffset(text, textarea.selectionEnd);
    const backwards = textarea.selectionDirection === 'backward';
    return { text, anchor: backwards ? end : start, caret: backwards ? start : end,
        composing: composing ? [start, end] : null };
}
function emitState() {
    if (!request.active || suspended) return;
    const state = readState();
    if (JSON.stringify(state) === JSON.stringify(observed)) return;
    observed = state;
    pending.push({session: request.active.id, action: {type: 'state', value: state}});
}
function action(type) {
    if (request.active) pending.push({session: request.active.id, action: {type}});
}
function metrics() {
    const r = canvas.getBoundingClientRect();
    return {r, sx: r.width / geometry.width, sy: r.height / geometry.height};
}
function fieldBox(rect) {
    const {r, sx, sy} = metrics();
    return {left: r.left + (geometry.x + rect.origin.x * geometry.cw) * sx,
        top: r.top + (geometry.y + rect.origin.y * geometry.ch) * sy,
        width: rect.size.width * geometry.cw * sx,
        height: rect.size.height * geometry.ch * sy};
}
function positionField() {
    if (!request.active || !geometry) return;
    // Pan the whole presentation, including its pointer coordinate system,
    // only while the keyboard occludes the field. No game layout special case.
    canvas.style.transform = savedTransform;
    let box = fieldBox(request.active.rect);
    const viewport = window.visualViewport;
    if (viewport && document.activeElement === textarea) {
        const bottom = viewport.offsetTop + viewport.height;
        const shift = Math.min(0, bottom - box.top - box.height - 8);
        if (shift < 0) {
            canvas.style.transform = `${savedTransform} translateY(${shift}px)`;
            box = fieldBox(request.active.rect);
        }
    }
    Object.assign(textarea.style, {left: `${box.left}px`, top: `${box.top}px`,
        width: `${Math.max(1, box.width)}px`, height: `${Math.max(1, box.height)}px`});
}
function focus() {
    if (suspended) return;
    textarea.focus({preventScroll: true});
    positionField();
}
function setup() {
    canvas = document.querySelector('canvas');
    if (!canvas) return false;
    savedTransform = canvas.style.transform;
    textarea = document.createElement('textarea');
    textarea.setAttribute('aria-label', 'Edit text');
    textarea.autocapitalize = 'none';
    textarea.spellcheck = false;
    textarea.setAttribute('autocorrect', 'off');
    textarea.setAttribute('enterkeyhint', 'done');
    textarea.rows = 1;
    // Keep the DOM field focusable, but route pointer placement through the
    // game's own text metrics, not the fallback browser font's geometry.
    Object.assign(textarea.style, {position: 'fixed', opacity: '0.01',
        pointerEvents: 'none', fontSize: '16px', padding: '0', border: '0',
        resize: 'none', zIndex: '-1', left: '0', top: '0', width: '1px', height: '1px'});
    document.body.appendChild(textarea);
    textarea.addEventListener('input', emitState);
    textarea.addEventListener('compositionstart', () => { composing = true; });
    textarea.addEventListener('compositionend', () => { composing = false; emitState(); });
    document.addEventListener('selectionchange', () => {
        if (document.activeElement === textarea) emitState();
    });
    textarea.addEventListener('beforeinput', e => {
        if (!composing && !e.isComposing && (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph')) {
            if (e.cancelable) e.preventDefault();
            emitState(); action('submit');
        }
    });
    textarea.addEventListener('keydown', e => {
        if (e.isComposing || composing || e.keyCode === 229) return;
        if (e.key === 'Tab') {
            e.preventDefault(); emitState();
            if (request.active) pending.push({session: request.active.id,
                action: {type:'next_field', value:{backwards:e.shiftKey}}});
            return;
        }
        if (e.key === 'Enter' || e.key === 'Escape') {
            e.preventDefault(); emitState(); action(e.key === 'Enter' ? 'submit' : 'cancel');
        }
    });
    textarea.addEventListener('blur', positionField);
    // winit focuses the canvas on pointerdown. Refocus the edit control on
    // release, still within the browser's trusted user activation.
    canvas.addEventListener('pointerup', e => {
        if (!geometry || suspended) return;
        const {r, sx, sy} = metrics();
        const x = ((e.clientX - r.left) / sx - geometry.x) / geometry.cw;
        const y = ((e.clientY - r.top) / sy - geometry.y) / geometry.ch;
        activating = request.activation_regions.some(b => x >= b.origin.x && y >= b.origin.y &&
            x < b.origin.x + b.size.width && y < b.origin.y + b.size.height);
        if (activating) focus();
    });
    window.visualViewport?.addEventListener('resize', positionField);
    window.visualViewport?.addEventListener('scroll', positionField);
    return true;
}
export function syncInputMethod(json, layout) {
    if (!textarea && !setup()) return;
    geometry = JSON.parse(layout);
    const next = JSON.parse(json);
    const changed = next.active?.id !== request.active?.id;
    request = next;
    if (!next.active) {
        if (document.activeElement === textarea) { textarea.blur(); canvas.focus({preventScroll: true}); }
        observed = null; composing = false;
        canvas.style.transform = savedTransform;
    } else {
        const state = next.active.state;
        // A pending platform edit has not yet reached the application. Never
        // overwrite it with an older frame's snapshot.
        if (changed || (!composing && pending.length === 0 && JSON.stringify(state) !== JSON.stringify(observed))) {
            textarea.value = state.text;
            const a = utf16Offset(state.text, state.anchor), b = utf16Offset(state.text, state.caret);
            textarea.setSelectionRange(Math.min(a,b), Math.max(a,b), a > b ? 'backward' : 'forward');
            observed = state;
        }
        if ((changed || activating) && !suspended) focus();
        positionField();
    }
    activating = false;
}
export function takeInputMethodEvents() {
    const result = JSON.stringify(pending); pending = []; return result;
}
export function suspendInputMethod() {
    suspended = true;
    if (textarea) textarea.blur();
    if (canvas) canvas.style.transform = savedTransform;
}
export function resumeInputMethod() { suspended = false; }
