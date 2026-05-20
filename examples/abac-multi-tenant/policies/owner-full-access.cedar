// Document owners have full access to their own documents
permit (
  principal,
  action,
  resource
)
when {
  principal.name == resource.owner_id
};
