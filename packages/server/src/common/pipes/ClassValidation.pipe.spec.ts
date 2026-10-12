import { BadRequestException } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ValidationPipe } from './ClassValidation.pipe';

const SECRET = 'sup3r-s3cret-api-key-value';

class ChildDto {
  @IsString()
  @MinLength(100)
  passphrase: string;
}

class SecretDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @MinLength(100)
  apiSecret: string;

  @ValidateNested()
  @Type(() => ChildDto)
  child: ChildDto;
}

async function capture(body: unknown): Promise<any> {
  const pipe = new ValidationPipe();
  try {
    await pipe.transform(body, { type: 'body', metatype: SecretDto });
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).getResponse();
  }
  throw new Error('expected validation to fail');
}

describe('ValidationPipe (class-validator)', () => {
  const body = {
    name: '',
    apiSecret: SECRET,
    child: { passphrase: SECRET },
  };

  it('keeps property and constraints in the error response', async () => {
    const res = await capture(body);
    const errors = Array.isArray(res) ? res : res.message;
    const secretErr = errors.find((e) => e.property === 'apiSecret');
    expect(secretErr.constraints.minLength).toBeDefined();
    expect(errors.find((e) => e.property === 'name').constraints).toBeDefined();
    const child = errors.find((e) => e.property === 'child');
    expect(child.children[0].property).toBe('passphrase');
    expect(child.children[0].constraints.minLength).toBeDefined();
  });

  it('never echoes target, value or the submitted secret', async () => {
    const res = await capture(body);
    const json = JSON.stringify(res);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain('"target"');
    expect(json).not.toContain('"value"');
  });

  it('does not carry target/value on nested children', async () => {
    const res = await capture(body);
    const errors = Array.isArray(res) ? res : res.message;
    const walk = (errs: any[]) => {
      for (const e of errs) {
        expect(e).not.toHaveProperty('target');
        expect(e).not.toHaveProperty('value');
        if (e.children) walk(e.children);
      }
    };
    walk(errors);
  });
});
