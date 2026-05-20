// Viewers can only GET — collection level and one level deep
permit (
  principal in API::Role::"viewer",
  action == API::Action::"GET",
  resource
)
when {
  resource.path == "/api/v1/projects"
  || resource.path like "/api/v1/projects/*"
};
