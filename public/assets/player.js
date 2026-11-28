(() => {
  const root = document.querySelector('[data-player]');
  if (!root) return;

  const frame = root.querySelector('iframe');
  const list = root.querySelector('[data-episodes]');
  const id = root.dataset.animeId;
  const sources = JSON.parse(root.dataset.sources || '[]');
  let episode = 1;
  let slot = 0;

  const urlFor = (src, ep) => src.playUrl.replace('{id}', src.ids?.[ep] ?? ep);

  function render(ep) {
    episode = ep;
    slot = 0;
    if (frame) {
      frame.src = urlFor(sources[slot], ep);
      frame.dataset.deadline = String(Date.now() + 20000);
    }
    if (location.hash !== `#ep-${ep}`) location.hash = `#ep-${ep}`;
    list?.querySelectorAll('a').forEach((a) => {
      a.toggleAttribute('aria-current', a.dataset.ep === String(ep));
    });
  }

  function nextSlot() {
    if (slot + 1 >= sources.length) return;
    slot += 1;
    if (frame) frame.src = urlFor(sources[slot], episode);
  }

  frame?.addEventListener('error', nextSlot);
  setInterval(() => {
    if (frame && Number(frame.dataset.deadline) < Date.now()) nextSlot();
  }, 5000);

  list?.addEventListener('click', (ev) => {
    const a = ev.target.closest('a[data-ep]');
    if (!a) return;
    ev.preventDefault();
    render(Number(a.dataset.ep));
  });

  addEventListener('hashchange', () => {
    const n = Number(location.hash.replace('#ep-', ''));
    if (n && n !== episode) render(n);
  });

  fetch(`/data/episodes/${id}.json`)
    .then((r) => r.json())
    .then((eps) => {
      if (!list) return;
      list.innerHTML = eps.map((e) =>
        `<li><a href="#ep-${e.n}" data-ep="${e.n}">Episódio ${e.n}</a></li>`).join('');
      const start = Number(location.hash.replace('#ep-', '')) || 1;
      render(start);
    })
    .catch(() => {});
})();
