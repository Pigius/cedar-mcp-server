// Only pro and enterprise plan users can share documents
permit (
  principal,
  action == SaaS::Action::"SHARE",
  resource
)
when {
  principal.plan == "pro" || principal.plan == "enterprise"
};
