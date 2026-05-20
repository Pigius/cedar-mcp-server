// Any authenticated user can read internal and public documents
permit (
  principal,
  action == SaaS::Action::"READ",
  resource
)
when {
  ["internal", "public"].contains(resource.visibility)
};
