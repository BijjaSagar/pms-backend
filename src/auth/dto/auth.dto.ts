import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(320)
  email: string;

  @IsString()
  @MinLength(1, { message: 'Enter your password' })
  @MaxLength(200)
  password: string;
}

export class SwitchPropertyDto {
  @IsString()
  @MaxLength(64)
  propertyId: string;
}