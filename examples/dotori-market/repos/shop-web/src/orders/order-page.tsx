import { useGetOrderQuery } from '../generated/graphql';
import { cancelOrder } from '../lib/api';

export function OrderPage({ id }: { id: string }) {
  const { data } = useGetOrderQuery({ variables: { id } });
  const onCancel = () => cancelOrder(id);
  return { order: data?.order, onCancel };
}
