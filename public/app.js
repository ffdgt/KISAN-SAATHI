const $ = (id) => document.getElementById(id);

let token = null;
let user = null;
let coords = { lat: null, lng: null };
let eventSource = null;

function authHeaders() {
  return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
}

function setAuthStatus(msg, ok = true) {
  $('authStatus').textContent = msg;
  $('authStatus').className = ok ? 'ok' : 'err';
}

function setLocationStatus(msg) {
  $('locationStatus').textContent = msg;
}

$('startOtpBtn').onclick = async () => {
  const phone = $('phone').value.trim();
  const role = $('role').value;
  if (!phone) return setAuthStatus('Enter phone', false);
  const res = await fetch('/api/auth/otp/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, role })
  });
  const data = await res.json();
  if (res.ok) setAuthStatus('OTP sent (use 123456)');
  else setAuthStatus(data.error || 'Failed', false);
};

$('verifyOtpBtn').onclick = async () => {
  const phone = $('phone').value.trim();
  const role = $('role').value;
  const otp = $('otp').value.trim();
  const res = await fetch('/api/auth/otp/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, role, otp })
  });
  const data = await res.json();
  if (!res.ok) return setAuthStatus(data.error || 'Verify failed', false);
  token = data.token;
  user = data.user;
  setAuthStatus('Logged in as ' + user.role + ' ✓', true);
  $('auth').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('farmerPanel').style.display = user.role === 'farmer' ? 'block' : 'none';
  $('workerPanel').style.display = user.role === 'worker' ? 'block' : 'none';
  connectEvents();
};

$('getLocationBtn').onclick = () => {
  if (!navigator.geolocation) return setLocationStatus('Geolocation not supported');
  setLocationStatus('Getting location...');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      coords.lat = pos.coords.latitude;
      coords.lng = pos.coords.longitude;
      setLocationStatus(`Lat ${coords.lat.toFixed(5)}, Lng ${coords.lng.toFixed(5)}`);
    },
    (err) => setLocationStatus('Failed: ' + err.message),
    { enableHighAccuracy: true, timeout: 10000 }
  );
};

$('saveWorkerBtn').onclick = async () => {
  if (!coords.lat) return ($('saveWorkerStatus').textContent = 'Click "Use my location" first');
  const body = {
    name: $('workerName').value.trim(),
    lat: coords.lat,
    lng: coords.lng,
    radiusKm: parseFloat($('workerRadius').value),
    skills: $('workerSkills').value.split(',').map((s) => s.trim()).filter(Boolean),
    rate: parseFloat($('workerRate').value),
    availableToday: $('availableToday').checked
  };
  const res = await fetch('/api/workers/me/profile', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body)
  });
  const data = await res.json();
  $('saveWorkerStatus').textContent = res.ok ? 'Saved ✓' : data.error || 'Failed';
};

$('searchWorkersBtn').onclick = async () => {
  if (!coords.lat) return alert('Click "Use my location" first');
  const params = new URLSearchParams({
    lat: coords.lat,
    lng: coords.lng,
    radius: $('searchRadius').value,
    skills: $('searchSkills').value,
    minRate: $('minRate').value,
    maxRate: $('maxRate').value,
    onlyAvailable: 'true'
  });
  const res = await fetch('/api/workers/nearby?' + params.toString());
  const data = await res.json();
  renderWorkers(data.results || []);
};

$('postJobBtn').onclick = async () => {
  if (!coords.lat) return ($('postJobStatus').textContent = 'Click "Use my location" first');
  const body = {
    title: $('jobTitle').value,
    description: $('jobDesc').value,
    wage: parseFloat($('jobWage').value),
    numWorkers: parseInt($('jobNum').value || '1'),
    lat: coords.lat,
    lng: coords.lng,
    radiusKm: parseFloat($('jobRadius').value)
  };
  const res = await fetch('/api/jobs', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body)
  });
  const data = await res.json();
  $('postJobStatus').textContent = res.ok ? `Job posted: ${data.job.title}` : data.error || 'Failed';
};

$('searchJobsBtn').onclick = async () => {
  if (!coords.lat) return alert('Click "Use my location" first');
  const params = new URLSearchParams({ lat: coords.lat, lng: coords.lng, radius: $('jobsRadius').value });
  const res = await fetch('/api/jobs/nearby?' + params.toString());
  const data = await res.json();
  renderJobs(data.results || []);
};

function renderWorkers(list) {
  const ul = $('workersList');
  ul.innerHTML = '';
  list.forEach((w) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <div>
        <strong>${escapeHtml(w.name || 'Worker')}</strong>
        — ${w.distanceKm} km — ₹${w.rate}/day — Skills: ${(w.skills || []).join(', ')}
        — ${w.availableToday ? 'Available today' : 'Not available'}
      </div>
      ${user?.role === 'farmer' ? `<button class="inviteBtn" data-userid="${w.userId}">Invite</button>` : ''}
      ${w.phone ? `<div class="muted">Phone: ${w.phone}</div>` : ''}
    `;
    ul.appendChild(li);
  });
  ul.querySelectorAll('.inviteBtn').forEach((btn) => {
    btn.onclick = async () => {
      const workerId = btn.dataset.userid;
      const jobId = await ensureRecentJob();
      if (!jobId) return alert('Post a job first.');
      const res = await fetch(`/api/jobs/${jobId}/invite/${workerId}`, { method: 'POST', headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) return alert(data.error || 'Invite failed');
      alert('Invited!');
    };
  });
}

async function ensureRecentJob() {
  const res = await fetch('/api/me', { headers: authHeaders() });
  if (!res.ok) return null;
  const m = await res.json();
  const myId = m.user.id;
  const resp = await fetch('/api/jobs/nearby?lat=' + coords.lat + '&lng=' + coords.lng + '&radius=50');
  const list = (await resp.json()).results || [];
  const mine = list.filter((j) => j.farmerId === myId);
  return mine.length ? mine[0].id : null;
}

function renderJobs(list) {
  const ul = $('jobsList');
  ul.innerHTML = '';
  list.forEach((j) => {
    const li = document.createElement('li');
    li.innerHTML = `<div>
      <strong>${escapeHtml(j.title)}</strong>
      — ${j.distanceKm} km — ₹${j.wage}/day — Need ${j.numWorkers}
    </div>`;
    ul.appendChild(li);
  });
}

function connectEvents() {
  if (!token) return;
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/events?token=' + encodeURIComponent(token));
  eventSource.onmessage = (e) => {
    const msg = JSON.parse(e.data || '{}');
    addAlert(msg);
  };
  eventSource.addEventListener('ping', () => {});
  eventSource.onerror = () => {
    console.log('SSE error, retrying soon');
  };
}

function addAlert(msg) {
  const ul = $('alerts');
  const li = document.createElement('li');
  if (msg.type === 'job_alert') {
    li.textContent = `New job: ${msg.title}, ₹${msg.wage}/day at ${msg.distanceKm} km`;
  } else if (msg.type === 'invite') {
    li.innerHTML = `Invitation: ${msg.title} — ₹${msg.wage} <button id="accept_${msg.inviteId}">Accept</button>`;
    setTimeout(() => {
      const b = document.getElementById('accept_' + msg.inviteId);
      if (b) b.onclick = () => acceptInvite(msg.inviteId);
    }, 0);
  } else if (msg.type === 'invite_response') {
    li.textContent = `Worker accepted invite ${msg.inviteId}`;
  } else {
    li.textContent = JSON.stringify(msg);
  }
  ul.prepend(li);
}

async function acceptInvite(inviteId) {
  const res = await fetch('/api/invites/' + inviteId + '/accept', { method: 'POST', headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) alert(data.error || 'Failed to accept invite');
  else addAlert({ type: 'info', text: 'Invite accepted ✓' });
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

