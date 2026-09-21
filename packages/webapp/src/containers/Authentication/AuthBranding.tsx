import { useEffect } from 'react';

// Selbourne logo, dark artwork on a transparent background.
export function AuthBrandLogo() {
  return (
    <img
      src="/branding/selbourne-logo.png"
      alt="Selbourne Financial"
      width={214}
      height={56}
      style={{ objectFit: 'contain' }}
    />
  );
}

// The auth pages use a light, brand-tinted background, so drop Blueprint's
// dark theme while mounted and restore it afterwards.
export function useForceLightTheme() {
  useEffect(() => {
    const targets = [document.documentElement, document.body];
    const wasDark = targets.filter((el) => el.classList.contains('bp4-dark'));

    const hadAuthClass = document.body.classList.contains('authentication');

    targets.forEach((el) => el.classList.remove('bp4-dark'));
    document.body.classList.add('authentication');

    return () => {
      wasDark.forEach((el) => el.classList.add('bp4-dark'));
      if (!hadAuthClass) document.body.classList.remove('authentication');
    };
  }, []);
}
