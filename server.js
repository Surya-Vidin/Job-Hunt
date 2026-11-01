import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import Database from 'better-sqlite3';
import pdf from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';

const app = express();
const up = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5e6 } }); // resumes are never written to disk
const db = new Database('jobs.db');
db.exec('create table if not exists cache(k text primary key, t int, v text)');
const cached = async (k, ttl, fn) => {
  const r = db.prepare('select t,v from cache where k=?').get(k);
  if (r && Date.now() - r.t < ttl) return JSON.parse(r.v);
  const v = await fn();
  db.prepare('insert or replace into cache values(?,?,?)').run(k, Date.now(), JSON.stringify(v));
  return v;
};
const strip = s => (s || '').replace(/<[^>]+>/g, ' ').replace(/&\w+;/g, ' ').replace(/\s+/g, ' ').trim();
const getJSON = async (u) => { const r = await fetch(u, { headers: { 'User-Agent': 'RegentJobs/1.0' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };

// Normalise a job. Contact info is ONLY what the posting text itself publishes.
const mk = o => {
  const d = o.desc || '', t = `${o.title} ${d}`;
  const emails = [...new Set(d.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) || [])].slice(0, 3);
  const phones = [...new Set(d.match(/\+\d[\d\s().-]{8,16}\d/g) || [])].slice(0, 2);
  const y = t.match(/(\d{1,2})\s*\+?\s*(?:[-–]\s*\d{1,2}\s*)?years?/i);
  const exp = y ? +y[1] : /intern|junior|entry|fresher|graduate/i.test(o.title) ? 0 : /senior|sr\.|lead|principal/i.test(o.title) ? 5 : null;
  return { ...o, desc: d.slice(0, 1500), emails, phones, exp };
};

const sources = {
  async adzuna(p) { // official API, free key, requires attribution + ToS compliance
    const { ADZUNA_APP_ID: id, ADZUNA_APP_KEY: key } = process.env;
    if (!id || !key) throw new Error('ADZUNA keys not set');
    const u = new URL(`https://api.adzuna.com/v1/api/jobs/${p.country || 'in'}/search/1`);
    u.search = new URLSearchParams({ app_id: id, app_key: key, results_per_page: 50, what: p.q || '',
      ...(p.city || p.state ? { where: p.city || p.state } : {}), ...(p.radius ? { distance: p.radius } : {}),
      ...(p.salaryMin ? { salary_min: p.salaryMin } : {}), ...(p.salaryMax ? { salary_max: p.salaryMax } : {}) });
    return (await getJSON(u)).results.map(r => mk({ id: 'az' + r.id, src: 'Adzuna', title: r.title, company: r.company?.display_name || '',
      location: r.location?.display_name || '', min: r.salary_min, max: r.salary_max, url: r.redirect_url, date: r.created, desc: strip(r.description), remote: /remote/i.test(r.title) }));
  },
  async remotive(p) { // public API; remote jobs; must link back to Remotive
    const j = await getJSON(`https://remotive.com/api/remote-jobs?limit=50&search=${encodeURIComponent(p.q || '')}`);
    return j.jobs.map(r => mk({ id: 'rm' + r.id, src: 'Remotive', title: r.title, company: r.company_name, location: r.candidate_required_location || 'Remote',
      salaryText: r.salary, url: r.url, date: r.publication_date, desc: strip(r.description), remote: true }));
  },
  async arbeitnow(p) { // public API, no key; Europe-focused
    const j = await getJSON('https://www.arbeitnow.com/api/job-board-api');
    const toks = (p.q || '').toLowerCase().split(/\s+/).filter(Boolean);
    return j.data.map(r => mk({ id: 'an' + r.slug, src: 'Arbeitnow', title: r.title, company: r.company_name, location: r.location, url: r.url,
      date: new Date(r.created_at * 1000).toISOString(), desc: strip(r.description), remote: r.remote }))
      .filter(r => toks.every(t => `${r.title} ${r.company} ${r.desc}`.toLowerCase().includes(t)));
  },
};

const num = v => (v === undefined || v === '' ? 0 : +v);
async function find(p) {
  return cached('s' + JSON.stringify(p), 15 * 60e3, async () => {
    const names = Object.keys(sources), status = {};
    const res = await Promise.allSettled(names.map(n => sources[n](p)));
    let jobs = [];
    res.forEach((r, i) => { status[names[i]] = r.status === 'fulfilled' ? r.value.length : 'unavailable: ' + r.reason.message; if (r.value) jobs.push(...r.value); });
    const loc = [p.city, p.state].filter(Boolean).map(s => s.toLowerCase());
    jobs = jobs.filter(j =>
      (!p.salaryMin || (j.min == null && j.max == null) || (j.max ?? j.min) >= p.salaryMin) &&
      (!p.salaryMax || j.min == null || j.min <= p.salaryMax) &&
      (!p.expMin || j.exp == null || j.exp >= p.expMin) && (!p.expMax || j.exp == null || j.exp <= p.expMax) &&
      (j.src === 'Adzuna' || j.remote || !loc.length || loc.some(l => j.location.toLowerCase().includes(l))));
    const seen = new Set();
    jobs = jobs.filter(j => { const k = (j.title + j.company).toLowerCase(); return seen.has(k) ? false : seen.add(k); })
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    return { jobs, status };
  });
}
const params = q => ({ q: (q.q || '').trim(), country: q.country, state: q.state, city: q.city, radius: num(q.radius),
  salaryMin: num(q.salaryMin), salaryMax: num(q.salaryMax), expMin: num(q.expMin), expMax: num(q.expMax) });

app.get('/api/search', async (req, res) => {
  try { res.json(await find(params(req.query))); } catch (e) { res.status(500).json({ error: e.message }); }
});

const SK = 'javascript,typescript,python,java,c#,c++,go,rust,php,ruby,swift,kotlin,sql,react,angular,vue,node.js,django,flask,spring,aws,azure,docker,kubernetes,git,linux,excel,tableau,power bi,machine learning,data analysis,seo,sales,marketing,accounting,customer service,project management,agile,scrum,figma,photoshop,nursing,teaching,logistics,recruiting,content writing'.split(',');
const ROLES = ['software engineer', 'developer', 'data analyst', 'data scientist', 'designer', 'accountant', 'nurse', 'teacher', 'marketing manager', 'sales executive', 'project manager', 'customer support', 'recruiter', 'devops engineer', 'product manager', 'business analyst'];
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

app.post('/api/resume', up.single('resume'), async (req, res) => {
  try {
    const f = req.file; if (!f) return res.status(400).json({ error: 'No file uploaded' });
    let text = '';
    if (/pdf$/i.test(f.originalname)) text = (await pdf(f.buffer)).text;
    else if (/docx$/i.test(f.originalname)) text = (await mammoth.extractRawText({ buffer: f.buffer })).value;
    else if (/txt$/i.test(f.originalname)) text = f.buffer.toString('utf8');
    else return res.status(400).json({ error: 'Upload a PDF, DOCX or TXT file' });
    if (text.trim().length < 50) return res.status(422).json({ error: 'Could not read text from this file (scanned image?). Try a text-based PDF or DOCX.' });
    const low = text.toLowerCase();
    const skills = SK.filter(k => new RegExp(`(^|[^a-z0-9+#])${esc(k)}($|[^a-z0-9+#])`, 'i').test(low));
    const years = Math.min(40, Math.max(0, ...[...low.matchAll(/(\d{1,2})\s*\+?\s*years/g)].map(m => +m[1])));
    const title = ROLES.find(r => low.includes(r)) || '';
    const q = title || skills.slice(0, 2).join(' ');
    if (!q) return res.json({ profile: { skills, years, title }, jobs: [], status: {}, note: 'No recognisable skills found; try searching manually.' });
    const { jobs, status } = await find({ ...params(req.body), q });
    const ranked = jobs.map(j => {
      const hay = `${j.title} ${j.desc}`.toLowerCase(), hit = skills.filter(s => hay.includes(s));
      const fit = j.exp == null || j.exp <= years + 1 ? 1 : 0.5;
      return { ...j, matched: hit, score: Math.min(99, Math.round((hit.length / Math.max(3, skills.length) * 70 + (title && j.title.toLowerCase().includes(title) ? 30 : 0)) * fit)) };
    }).sort((a, b) => b.score - a.score).slice(0, 25);
    res.json({ profile: { skills, years, title }, jobs: ranked, status });
  } catch (e) { res.status(500).json({ error: 'Resume parsing failed: ' + e.message }); }
});

app.use(express.static('public'));
app.listen(process.env.PORT || 3000, () => console.log('Regent running on http://localhost:' + (process.env.PORT || 3000)));
