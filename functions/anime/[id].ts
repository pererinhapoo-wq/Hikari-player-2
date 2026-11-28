export const onRequest: PagesFunction = async ({ request, params, env }) => {
  const url = new URL(request.url);
  const id = String(params.id);

  const mapRes = await env.ASSETS.fetch(new URL('/data/slug-map.json', url.origin));
  if (!mapRes.ok) return env.ASSETS.fetch(request);

  const map = await mapRes.json();
  const canonical = map[id];
  if (!canonical || canonical === id) return env.ASSETS.fetch(request);

  return Response.redirect(`${url.origin}/anime/${canonical}`, 301);
};
