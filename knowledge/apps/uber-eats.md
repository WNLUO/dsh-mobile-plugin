---
name: uber-eats
display: Uber Eats
description: 外卖，餐厅、菜单与订单
packages: ["com.ubercab.eats"]
aliases: ["Uber Eats", "UberEats", "uber eats", "ubereats"]
sites: ["ubereats.com"]
open: Uber Eats
pace: careful
---
## 是什么
Uber Eats 是外卖 App，包名 `com.ubercab.eats`。点餐、看餐厅菜单、购物车和订单都在里面；网页版在 `ubereats.com`。

## 界面
有 Home/搜索、餐厅菜单、Cart 和 Orders。外卖餐饮和 Grocery、Convenience、Retail 等是分开的频道。Home 顶部是配送地址和搜索，下面是餐厅/商品列表。

## 功能
- 餐厅：按配送地址查看，能看到名称、评分、点评、预计送达时间、配送费、优惠、营业状态，有 Delivery 和 Pickup 两种方式；已打烊的餐厅没有预计送达时间。
- 菜单：菜名、分类、原币种价格、选项、是否售罄，通常不登录也能看。
- 购物车：显示规格、数量、起送门槛、各项费用、地址与门牌详情和总额；Add 点一次加一份。
- 订单：Orders 里有历史订单和当前订单的配送进度。

## 已知现象
- 餐厅和超市零售商品属于不同频道，切换频道才能看到不同品类。
- 界面可能出现登录或验证；下单和支付前会显示费用明细。
- 部分商品和餐厅只在特定配送地址范围内显示。
