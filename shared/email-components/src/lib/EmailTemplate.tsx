import { Container, Img, Section } from '@react-email/components';
import { CSSProperties } from 'react';
import { BRAND } from './brand';

interface EmailTemplateProps {
  children: React.ReactNode;
}
export function EmailTemplate({ children }: EmailTemplateProps) {
  return <Container style={containerStyle}>{children}</Container>;
}

// A real <img>, not a CSS background: mail clients commonly drop background
// images. Sized for a wide wordmark; a square logo simply renders smaller.
EmailTemplate.CompanyLogo = ({ src }: { src: string }) => {
  return (
    <Section style={logoSectionStyle}>
      <Img src={src} alt="" style={companyLogoStyle} />
    </Section>
  );
};

const containerStyle: CSSProperties = {
  backgroundColor: BRAND.paper,
  width: '100%',
  maxWidth: '500px',
  padding: '30px 20px',
  color: BRAND.ink,
  borderRadius: '5px',
};

const companyLogoStyle: CSSProperties = {
  display: 'block',
  width: 'auto',
  height: 'auto',
  maxWidth: '200px',
  maxHeight: '64px',
  marginLeft: 'auto',
  marginRight: 'auto',
};

const logoSectionStyle = {
  marginBottom: '15px',
};
