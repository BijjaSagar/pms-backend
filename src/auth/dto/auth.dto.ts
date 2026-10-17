import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(320)
  email: string;

  @IsString()
  @MinLength(1, { message: 'Enter your password' })
  @MaxLength(200)
  password: string;
}


export class RefreshTokenDto {
  @IsOptional()
  @IsString()
  refreshToken?: string;
}

export class ForgotPasswordDto {
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(320)
  email: string;
}

export class ResetPasswordDto {
  @IsString()
  @MinLength(1, { message: 'A reset token is required' })
  token: string;

  @IsString()
  @MinLength(12, { message: 'Choose a password of at least 12 characters' })
  @MaxLength(200)
  password: string;
}

export class SwitchPropertyDto {
  @IsString()
  @MaxLength(64)
  propertyId: string;
}