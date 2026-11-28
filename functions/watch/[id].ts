export const onRequest: PagesFunction = ({ request, params }) => {
  const url = new URL(request.url);
  return Response.redirect(`${url.origin}/e/${String(params.id)}`, 301);
};
