-- A person can discover the organization-owned accounts assigned to them
-- before choosing one. Existing session/turn gates still own execution and
-- binding writes. These SELECT-only policies confer no mutation authority and
-- never expose another person's personal connection or assignment.
SET LOCAL lock_timeout = '5s';

CREATE POLICY subscription_connection_people_own_read
  ON subscription_connection_people FOR SELECT
  USING (organization_membership_id =
    opengeni_private.subscription_own_person_membership_id(account_id));

CREATE POLICY subscription_connections_own_people_read
  ON subscription_connections FOR SELECT
  USING (ownership = 'shared' AND scope_kind = 'people'
    AND EXISTS (
      SELECT 1 FROM subscription_connection_people assignment
      WHERE assignment.account_id = subscription_connections.account_id
        AND assignment.connection_id = subscription_connections.id
        AND assignment.organization_membership_id =
          opengeni_private.subscription_own_person_membership_id(subscription_connections.account_id)
    ));
