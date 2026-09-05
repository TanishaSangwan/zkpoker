import type { Metadata } from 'next';
import SelfTestClient from './SelfTestClient';

export const metadata: Metadata = {
  title: 'zkpoker · proving self-test',
  description: 'Checks that this deployment can actually generate a shuffle proof in the browser.',
};

export default function SelfTestPage() {
  return <SelfTestClient />;
}
