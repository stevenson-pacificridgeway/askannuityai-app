# Front-end wiring — the 6 edits to `public/index.html`

These swap the prototype's demo brain/auth for the real backend. (Tell me when Supabase is live and I'll apply these for you and re-deploy.)

### 0) Load the bridge — just before `</body>`
```html
<script src="/aai-config.js"></script>
<script type="module" src="/aai-backend.js"></script>
```

### 1) Real Google sign-in
Replace the demo handlers:
```js
$('googleBtn').onclick = () => AAI.signInWithGoogle();
$('welcomeGoogle').onclick = () => { localStorage.setItem('aai_pending_lead','1'); S(LS.welcomed,1); AAI.signInWithGoogle(); };
```

### 2) React to real auth (add once, e.g. near the bottom of the script)
```js
window.addEventListener('aai-ready', () => {
  AAI.onAuth(user => {
    if (user) {
      setUser({ name: user.name, email: user.email, provider: 'google' });
      if (localStorage.getItem('aai_pending_lead')) {
        AAI.saveLead({ name:user.name, email:user.email,
          message:'Wants to continuously learn (welcome popup)', source:'Welcome popup' });
        localStorage.removeItem('aai_pending_lead');
      }
    }
  });
});
```

### 3) Real AI answers — inside `send()`, replace the block that sets `answerText`/`source`
```js
let answerText, source;
try {
  const r = await AAI.askAI(q);
  answerText = r.answer;
  source = (r.sources || []).join(', ') || 'AskAnnuityAI knowledge base';
} catch (e) {
  answerText = "Sorry — I had trouble reaching the assistant. Please try again in a moment.";
  source = '';
}
```
(The server's system prompt already enforces the "education only / see a professional" guardrail, so you can keep or drop the client-side ADVICE check.)

### 4) Admin file upload — replace `handleFiles()`
```js
async function handleFiles(files){
  for (const file of files) {
    try { const r = await AAI.uploadDoc(file); toast(`Added "${r.title}" (${r.chunks} chunks)`); }
    catch(e){ toast('Upload failed: ' + e.message); }
  }
}
```

### 5) Admin paste-to-brain — in the Add-to-knowledge handler
```js
AAI.ingestText(title, text).then(r => toast(`Added (${r.chunks} chunks)`));
```

### 6) Leads — in the `leadForm` submit handler, replace the mailto/localStorage line
```js
AAI.saveLead({ name:d.name, email:d.email, phone:d.phone, amount:d.amount, message:d.message, source:'Contact form' });
```

That's it — the gorgeous UI stays exactly the same; only the wiring underneath becomes real.
