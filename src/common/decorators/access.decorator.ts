import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_ROUTE = 'is_public_route';
export const SKIP_PERMISSION_CHECK = 'skip_permission_check';
export const REQUIRED_PERMISSIONS = 'required_permissions';

/** Use on login/health/password-reset routes and teach the AuthGuard to honor it too. */
export const Public = () => SetMetadata(IS_PUBLIC_ROUTE, true);

/** Use sparingly for authenticated endpoints such as GET /auth/me that do not need a domain permission. */
export const SkipPermissionCheck = () => SetMetadata(SKIP_PERMISSION_CHECK, true);

/** Declare all permission keys required by a controller or route handler. */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);
