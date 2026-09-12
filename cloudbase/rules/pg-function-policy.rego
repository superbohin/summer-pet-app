# For a PG environment with no existing user Rego policy. When a policy already
# exists, merge these uniquely named rules; never overwrite unrelated policies.
# Verify both access-key-only rejection and real anonymous-session acceptance.
package authz.user

summer_pet_family_request if {
  input.cloudbase.entrypoint_type == "tcbopenapi"
  input.cloudbase.resource_type == "functions"
  input.request.path == "/v1/functions/summer-pet-family"
}

summer_pet_family_privileged if {
  input.subject.auth_type in {"administrator", "service_role"}
}

summer_pet_family_user_session if {
  input.subject.auth_type in {"anon", "authenticated", "anonymous", "internal", "external"}
  is_string(input.subject.user_id)
  input.subject.user_id != ""
  input.subject.user_id != "anon"
}

deny contains "summer-pet-family requires a signed-in user session" if {
  summer_pet_family_request
  input.request.method != "OPTIONS"
  not summer_pet_family_privileged
  not summer_pet_family_user_session
}
