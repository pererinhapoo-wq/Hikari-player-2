export const onRequest: PagesFunction = ({ request, params }) => {
  const url = new URL(request.url);
  const id = String(params.id);
  const n = Number(String(params.ep).replace(/^ep-/, ''));
  const target = Number.isInteger(n) && n > 0 ? `/e/${id}#ep-${n}` : `/e/${id}`;
  return Response.redirect(`${url.origin}${target}`, 301);
};
